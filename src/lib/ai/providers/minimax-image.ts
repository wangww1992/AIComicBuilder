import type { AIProvider, TextOptions, ImageOptions } from "../types";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

// ── Helpers ────────────────────────────────────────────────────────────────

// Local file → data URL so we can ship it in the JSON body. MiniMax's
// `subject_reference[].image_file` field accepts http(s) URLs and most
// public CDNs do the right thing with data: URIs too; if a future model
// refuses them we can swap in an upload step.
function toDataUrl(filePathOrUrl: string): string {
  if (filePathOrUrl.startsWith("http://") || filePathOrUrl.startsWith("https://")) {
    return filePathOrUrl;
  }
  const ext = path.extname(filePathOrUrl).toLowerCase().replace(".", "");
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "image/png";
  const base64 = fs.readFileSync(filePathOrUrl, { encoding: "base64" });
  return `data:${mime};base64,${base64}`;
}

// ── Response types ─────────────────────────────────────────────────────────

interface MiniMaxImageResponse {
  data?: { image_base64?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
  // Some endpoints nest the error envelope as top-level too
  status_code?: number;
  status_msg?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

// MiniMax rejects image prompts longer than this. We compress via the
// project's text LLM when available, falling back to a hard slice.
const MAX_PROMPT_LENGTH = 1500;

// ── Provider ───────────────────────────────────────────────────────────────

export class MiniMaxImageProvider implements AIProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private uploadDir: string;
  /**
   * Optional text LLM used to compress prompts that exceed
   * MAX_PROMPT_LENGTH. Supplied by `createAIProvider` based on the
   * project's `modelConfig.text` so that the same model that wrote the
   * prompt is the one that compresses it (preserves vocabulary and tone).
   */
  private textProvider?: AIProvider;

  constructor(params?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    uploadDir?: string;
    textProvider?: AIProvider;
  }) {
    this.apiKey = params?.apiKey || process.env.MINIMAX_API_KEY || "";
    this.baseUrl = (
      params?.baseUrl || process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com"
    ).replace(/\/+$/, "");
    this.model = params?.model || process.env.MINIMAX_IMAGE_MODEL || "image-01";
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
    this.textProvider = params?.textProvider;
  }

  async generateText(_prompt: string, _options?: TextOptions): Promise<string> {
    throw new Error("MiniMax image models do not support text generation");
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    const model = options?.model || this.model;
    const finalPrompt = await this.compressPromptIfNeeded(prompt);

    // MiniMax expects `aspect_ratio` as a string like "16:9" — the
    // `ImageOptions.aspectRatio` from the codebase already matches.
    const body: Record<string, unknown> = {
      model,
      prompt: finalPrompt,
      aspect_ratio: options?.aspectRatio || "16:9",
      response_format: "base64",
    };

    // Subject-reference mode: keep a character (or object) consistent
    // across generations. Each ref becomes one entry in `subject_reference`.
    if (options?.referenceImages && options.referenceImages.length > 0) {
      body.subject_reference = options.referenceImages.map((img) => ({
        type: "character",
        image_file: toDataUrl(img),
      }));
    }

    console.log(
      `[MiniMaxImage] Generating: model=${model}, aspect_ratio=${body.aspect_ratio}, refs=${options?.referenceImages?.length ?? 0}, promptChars=${finalPrompt.length}`
    );

    const res = await fetch(`${this.baseUrl}/v1/image_generation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `MiniMax image request failed: ${res.status} ${errText}`
      );
    }

    const json = (await res.json()) as MiniMaxImageResponse;

    // Top-level status envelope (`base_resp`) is the canonical one.
    const statusCode = json.base_resp?.status_code ?? json.status_code;
    const statusMsg = json.base_resp?.status_msg ?? json.status_msg;
    if (statusCode !== undefined && statusCode !== 0) {
      throw new Error(
        `MiniMax image error [${statusCode}]: ${statusMsg ?? "unknown"}`
      );
    }

    const b64List = json.data?.image_base64;
    if (!b64List || b64List.length === 0 || !b64List[0]) {
      throw new Error(
        `MiniMax image: no image_base64 in response: ${JSON.stringify(json).slice(0, 500)}`
      );
    }

    const buffer = Buffer.from(b64List[0], "base64");
    const filename = `${genId()}.jpeg`;
    const dir = path.join(this.uploadDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    console.log(`[MiniMaxImage] Saved to ${filepath}`);
    return filepath;
  }

  /**
   * Compress a prompt that exceeds MiniMax's per-request limit.
   *
   * Strategy:
   *   1. If the prompt already fits, return as-is (zero cost).
   *   2. If a text LLM is wired in, ask it to rewrite the prompt in the
   *      same language, preserving visual details. This is the smart path.
   *   3. If the LLM is unavailable or its rewrite still overflows, fall
   *      back to a hard slice with an ellipsis so the request still goes
   *      through. Worst case the image loses some fidelity, but we never
   *      crash with a 2013 error.
   *
   * Exported via the class so callers / tests can drive it directly.
   */
  async compressPromptIfNeeded(prompt: string): Promise<string> {
    if (prompt.length <= MAX_PROMPT_LENGTH) return prompt;

    const overBy = prompt.length - MAX_PROMPT_LENGTH;
    console.warn(
      `[MiniMaxImage] Prompt is ${prompt.length} chars (over by ${overBy}); compressing...`
    );

    if (this.textProvider) {
      try {
        const compressed = await this.textProvider.generateText(
          COMPRESS_INSTRUCTION.replace(
            "{MAX}",
            String(MAX_PROMPT_LENGTH),
          ) + "\n\n---\n\n" + prompt,
          { temperature: 0.3 },
        );
        if (compressed.length <= MAX_PROMPT_LENGTH) {
          console.log(
            `[MiniMaxImage] Compressed prompt: ${prompt.length} → ${compressed.length} chars`,
          );
          return compressed;
        }
        console.warn(
          `[MiniMaxImage] Compressed prompt still ${compressed.length} chars; truncating to ${MAX_PROMPT_LENGTH}.`,
        );
        return compressed.slice(0, MAX_PROMPT_LENGTH - 3) + "...";
      } catch (err) {
        console.warn(
          `[MiniMaxImage] LLM compression failed (${err instanceof Error ? err.message : err}); falling back to hard slice.`,
        );
      }
    } else {
      console.warn(
        "[MiniMaxImage] No text LLM configured for compression; falling back to hard slice.",
      );
    }

    return prompt.slice(0, MAX_PROMPT_LENGTH - 3) + "...";
  }
}

const COMPRESS_INSTRUCTION = `You are compressing an image-generation prompt. The output MUST be at most {MAX} characters (the image model's hard limit) and MUST stay in the SAME LANGUAGE as the input.

Preserve, in roughly this priority order:
1. Subject identity and action (who/what, doing what)
2. Visual style and art direction (e.g. "cinematic", "anime", "photorealistic")
3. Composition, framing, camera angle, lens
4. Lighting, color palette, mood
5. Costume, props, background detail
6. Any negative cues ("no text", "no watermark")

Drop: filler words, redundant adjectives, meta-instructions ("this is for..."), and any sentence that doesn't change the picture.

Output ONLY the compressed prompt — no explanation, no quotes, no preamble.`;
