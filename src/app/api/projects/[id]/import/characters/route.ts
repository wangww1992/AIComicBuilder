import { NextResponse } from "next/server";
import { generateText } from "ai";
import { createHash } from "node:crypto";
import { createLanguageModel, extractJSON } from "@/lib/ai/ai-sdk";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";
import { db } from "@/lib/db";
import { projects, importLogs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { addImportLog, chunkText } from "@/lib/import-utils";
import { buildImportCharacterExtractPrompt } from "@/lib/ai/prompts/import-character-extract";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";

export const maxDuration = 300;

interface ExtractedChar {
  name: string;
  frequency: number;
  description: string;
  visualHint?: string;
}

interface ExtractedRelation {
  characterA: string;
  characterB: string;
  relationType: string;
  description?: string;
}

type ChunkResult = { chars: ExtractedChar[]; rels: ExtractedRelation[] };

/**
 * Marker prefix used in `import_logs.message` to flag rows that store a
 * successful per-chunk extraction result. We reuse the existing logs table
 * (rather than adding a column) so that:
 *   - the cache survives across retries / page reloads, and
 *   - a single `DELETE /import/logs` call wipes the cache when the user
 *     starts a fresh import.
 */
const CHUNK_CACHE_PREFIX = "[chunk-cache] ";

function hashChunk(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Classify an LLM call error so we know whether retrying makes any sense.
 *  - 4xx (except 408/429) is a config / input problem → permanent
 *  - 408/429/5xx/network errors are transient → retry
 */
function isPermanentError(err: unknown): boolean {
  // ai-sdk surfaces HTTP errors with a `statusCode` field on the thrown object.
  const status =
    (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { statusCode?: number; status?: number })?.status;
  if (typeof status === "number") {
    if (status === 408 || status === 429) return false; // timeout / rate limit
    if (status >= 400 && status < 500) return true; // 401/403/404/400 → don't retry
  }
  return false;
}

const RETRY_DELAYS_MS = [1000, 3000, 8000]; // up to 3 retries

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const userId = getUserIdFromRequest(request);

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json()) as {
    text: string;
    modelConfig: { text: ProviderConfig | null };
  };

  if (!body.modelConfig?.text) {
    return NextResponse.json({ error: "No text model" }, { status: 400 });
  }

  const chunks = chunkText(body.text);
  const model = createLanguageModel(body.modelConfig.text);
  const importCharSystem = await resolvePrompt("import_character_extract", { userId, projectId });

  // ── Load chunk-level cache from previous (partial) runs ─────────────
  const existingLogs = await db
    .select()
    .from(importLogs)
    .where(and(eq(importLogs.projectId, projectId), eq(importLogs.step, 2)));

  const cache = new Map<string, ChunkResult>();
  for (const log of existingLogs) {
    if (!log.message?.startsWith(CHUNK_CACHE_PREFIX)) continue;
    const meta = log.metadata as { hash?: string; result?: ChunkResult } | null;
    if (meta?.hash && meta.result) cache.set(meta.hash, meta.result);
  }

  const cachedHits = chunks.filter((c) => cache.has(hashChunk(c))).length;
  await addImportLog(
    projectId,
    2,
    "running",
    cachedHits > 0
      ? `开始角色提取，共 ${chunks.length} 块（${cachedHits} 块已缓存，跳过）`
      : `开始角色提取，共 ${chunks.length} 块`
  );

  // ── Run a single chunk through the LLM with per-call retry ──────────
  async function runChunk(chunk: string, idx: number): Promise<ChunkResult> {
    const jsonMode = { openai: { response_format: { type: "json_object" } } };
    let lastErr: unknown;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const result = await generateText({
          model,
          system: importCharSystem,
          prompt:
            buildImportCharacterExtractPrompt(chunk) +
            (attempt > 0 ? "\n\nIMPORTANT: Return COMPLETE, VALID JSON." : ""),
          providerOptions: jsonMode,
        });

        try {
          const parsed = JSON.parse(extractJSON(result.text));
          if (Array.isArray(parsed)) {
            return { chars: parsed as ExtractedChar[], rels: [] };
          }
          return {
            chars: (parsed.characters || []) as ExtractedChar[],
            rels: (parsed.relationships || []) as ExtractedRelation[],
          };
        } catch (parseErr) {
          // JSON parse failure is treated as transient — falls into retry.
          console.error(
            `[ImportChars] Chunk ${idx + 1} attempt ${attempt + 1} JSON parse failed. Raw:\n${result.text.slice(0, 500)}...`
          );
          lastErr = parseErr;
        }
      } catch (err) {
        lastErr = err;
        if (isPermanentError(err)) {
          // Config/input error — retrying won't help. Bubble up immediately
          // so the caller can surface the real reason (e.g. 404 model id).
          throw err;
        }
      }

      // Wait before next attempt (no wait after the final failed attempt).
      if (attempt < RETRY_DELAYS_MS.length) {
        await addImportLog(
          projectId,
          2,
          "running",
          `第 ${idx + 1} 块第 ${attempt + 1} 次失败，${RETRY_DELAYS_MS[attempt] / 1000}s 后重试...`
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // ── Process all chunks. Cached ones return instantly; new ones run ─
  // through the LLM. We use allSettled so a single bad chunk doesn't
  // poison the rest — but if EVERY chunk fails we still surface 500.
  const settled = await Promise.allSettled(
    chunks.map(async (chunk, idx) => {
      const hash = hashChunk(chunk);
      const cached = cache.get(hash);
      if (cached) return { idx, result: cached };

      await addImportLog(
        projectId,
        2,
        "running",
        `正在处理第 ${idx + 1}/${chunks.length} 块...`
      );

      const result = await runChunk(chunk, idx);

      // Persist this chunk's success so future retries skip it.
      await addImportLog(
        projectId,
        2,
        "done",
        `${CHUNK_CACHE_PREFIX}chunk ${idx + 1} ok`,
        { hash, result }
      );
      return { idx, result };
    })
  );

  const successes: ChunkResult[] = [];
  const failures: { idx: number; msg: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") successes.push(s.value.result);
    else failures.push({ idx: i, msg: s.reason instanceof Error ? s.reason.message : String(s.reason) });
  }

  if (successes.length === 0) {
    const msg = failures[0]?.msg ?? "Unknown error";
    await addImportLog(projectId, 2, "error", `角色提取失败: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Merge & deduplicate characters by name, sum frequencies
  const charMap = new Map<string, ExtractedChar>();
  const allRelations: ExtractedRelation[] = [];

  for (const { chars, rels } of successes) {
    for (const c of chars) {
      const key = c.name.toLowerCase().trim();
      const existing = charMap.get(key);
      if (existing) {
        existing.frequency += c.frequency;
        if (c.description.length > existing.description.length) {
          existing.description = c.description;
        }
      } else {
        charMap.set(key, { ...c });
      }
    }
    allRelations.push(...rels);
  }

  const merged = [...charMap.values()].sort((a, b) => b.frequency - a.frequency);

  // Classify: frequency >= 2 = main, else guest
  const result = merged.map((c) => ({
    ...c,
    scope: c.frequency >= 2 ? ("main" as const) : ("guest" as const),
  }));

  // Deduplicate relationships
  const relSet = new Set<string>();
  const uniqueRelations = allRelations.filter((r) => {
    const key = [r.characterA, r.characterB].sort().join("↔");
    if (relSet.has(key)) return false;
    relSet.add(key);
    return true;
  });

  if (failures.length > 0) {
    // Some chunks couldn't be processed even after retries. Log the failure
    // but still return what we have so the user can fix config and click
    // Retry — the successful chunks are already cached and will be skipped.
    const sample = failures.slice(0, 3).map((f) => `#${f.idx + 1}: ${f.msg}`).join("; ");
    await addImportLog(
      projectId,
      2,
      "error",
      `${failures.length}/${chunks.length} 块失败，已保留 ${successes.length} 块结果。重试将仅处理失败块。示例: ${sample}`
    );
    return NextResponse.json(
      {
        error: `${failures.length}/${chunks.length} chunks failed`,
        failures,
        partialCharacters: result,
        partialRelationships: uniqueRelations,
      },
      { status: 500 }
    );
  }

  await addImportLog(
    projectId,
    2,
    "done",
    `提取完成，共 ${result.length} 个角色（主角 ${result.filter((c) => c.scope === "main").length}，配角 ${result.filter((c) => c.scope === "guest").length}），${uniqueRelations.length} 个关系`,
    { characters: result, relationships: uniqueRelations }
  );

  return NextResponse.json({ characters: result, relationships: uniqueRelations });
}
