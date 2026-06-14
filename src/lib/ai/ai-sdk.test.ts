// @ts-nocheck — test file uses Node 22 `--experimental-strip-types`, which
// requires the `.ts` extension in relative imports. The project's tsc
// build is not expected to type-check this file.
/**
 * Tests for `extractJSON` — the central helper that turns raw LLM output
 * into a JSON-parseable string. Run with:
 *   node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts
 *
 * Background: bug report — 角色提取 fails with
 *   `Unexpected token '<', "<think>Let"... is not valid JSON`
 * because Qwen3 / DeepSeek-R1 / GLM-4 etc. emit `<think>...</think>`
 * reasoning blocks BEFORE the JSON, and the current extractor only
 * strips ```json fences. These tests pin down the fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJSON, stripThinking } from "./ai-sdk.ts";
import { compressPrompt } from "./providers/prompt-compress.ts";
import { fetchAnthropicModels } from "./providers/anthropic-models.ts";
import {
  parseArkImageResponse,
  buildArkImageBody,
  buildArkImageUrl,
  isHttpUrl,
  mimeFromPath,
} from "./providers/ark-models.ts";
import {
  allowedResolutionsFor,
  defaultResolutionFor,
  isKeyframeSupported,
  validateMiniMaxVideoRequest,
} from "./providers/minimax-video-models.ts";
import type { AIProvider } from "./types.ts";

const char = (name: string) =>
  JSON.stringify({ name, frequency: 1, description: "x", visualHint: "x" });

test("pure JSON object passes through", () => {
  const text = `{"characters": [${char("Alice")}], "relationships": []}`;
  assert.equal(JSON.parse(extractJSON(text)).characters[0].name, "Alice");
});

test("JSON inside a ```json fence is unwrapped", () => {
  const text = "```json\n" + `{"characters": [${char("Alice")}]}` + "\n```";
  assert.equal(JSON.parse(extractJSON(text)).characters[0].name, "Alice");
});

test("JSON inside a bare ``` fence is unwrapped", () => {
  const text = "```\n" + `{"characters": [${char("Alice")}]}` + "\n```";
  assert.equal(JSON.parse(extractJSON(text)).characters[0].name, "Alice");
});

// Regression: the bug the user hit
test("REGRESSION: <think>...</think> block is stripped before parse (Qwen3 / GLM-4)", () => {
  const text =
    "<think>Let me analyze the text and find the characters.\n" +
    "I see Alice and Bob. I will output JSON now.</think>\n" +
    `{"characters": [${char("Alice")}, ${char("Bob")}], "relationships": []}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters.length, 2);
  assert.equal(parsed.characters[0].name, "Alice");
});

test("DeepSeek-R1 special-token think block is stripped", () => {
  const text =
    "<|begin▁of▁think|>Let me think about this carefully.<|end▁of▁think|>\n" +
    `{"characters": [${char("Alice")}]}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

test("DeepSeek-R1 with underscore begin/end markers is stripped", () => {
  const text =
    "<|begin_of_think|>reasoning<|end_of_think|>\n" +
    `{"characters": [${char("Alice")}]}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

test("multiple <think> blocks in one response are all stripped", () => {
  const text =
    "<think>first thought</think>Some prose in between.<think>second thought</think>\n" +
    `{"characters": [${char("Alice")}]}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

// Prose-around-JSON cases (no fence, no think tag)
test("prose preamble + raw JSON object: the JSON is extracted", () => {
  const text =
    "Sure, here is the JSON you asked for:\n" +
    `{"characters": [${char("Alice")}]}\n` +
    "Let me know if you need anything else.";
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

test("prose preamble + raw JSON array: the array is extracted", () => {
  const text = `Here are the characters:\n[${char("Alice")}, ${char("Bob")}]\nDone.`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.length, 2);
});

// Sanity: already-clean inputs are unchanged
test("array input is returned verbatim when clean", () => {
  const text = `[${char("Alice")}, ${char("Bob")}]`;
  assert.deepEqual(JSON.parse(extractJSON(text)), JSON.parse(text));
});

test("object input is returned verbatim when clean", () => {
  const text = `{"characters": [${char("Alice")}]}`;
  assert.deepEqual(JSON.parse(extractJSON(text)), JSON.parse(text));
});

// Robustness: a real NUL control char between two letters of a name is stripped
test("real NUL control char in text is removed", () => {
  // Build the input by concatenation so the NUL stays as a real char
  // instead of being JSON-escaped away by JSON.stringify.
  const text = `{"characters":[{"name":"Ali${"\x00"}ce"}]}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

// ── stripThinking: the plain-text counterpart of extractJSON ──────────
// Used for streaming text output (script_outline, script_generate, ...)
// where we want the model's chain-of-thought hidden from the user / DB.

test("stripThinking: removes a single <think> block (Qwen3 / GLM-4)", () => {
  const text = "<think>The user wants a story about Alice and Bob.</think>" +
    "Alice went to the market. Bob stayed home.";
  assert.equal(
    stripThinking(text),
    "Alice went to the market. Bob stayed home."
  );
});

test("stripThinking: removes DeepSeek-R1 unicode think markers", () => {
  const text =
    "<|begin▁of▁think|>let me think<|end▁of▁think|>\nThe answer is 42.";
  // The leading newline after the think block is preserved — trimming
  // is the caller's job.
  assert.equal(stripThinking(text), "\nThe answer is 42.");
});

test("stripThinking: removes DeepSeek-R1 underscore think markers", () => {
  const text = "<|begin_of_think|>reasoning<|end_of_think|>\nFinal answer.";
  // The leading newline after the think block is preserved — trimming
  // is the caller's job (it varies whether the model leaves one).
  assert.equal(stripThinking(text), "\nFinal answer.");
});

test("stripThinking: removes multiple <think> blocks in one response", () => {
  const text =
    "<think>first thought</think>Hello, <think>second thought</think>world.";
  assert.equal(stripThinking(text), "Hello, world.");
});

test("stripThinking: leaves plain text untouched", () => {
  const text = "Just a normal story about Alice and Bob. No thinking here.";
  assert.equal(stripThinking(text), text);
});

test("stripThinking: collapses extra blank lines left behind", () => {
  // After stripping a block, multiple consecutive newlines can pile up.
  // We do NOT trim/collapse here — that's the caller's job — but we
  // verify the helper leaves predictable whitespace.
  const text = "<think>thought</think>\n\n\nReal text.";
  assert.equal(stripThinking(text), "\n\n\nReal text.");
});

// ── compressPrompt: MiniMax's 1500-char prompt cap ───────────────────────
// Bug report: MiniMax image-01 returns 2013 "prompt length must be less
// than 1500" when the upstream keyframe-prompt generator over-fluffs its
// output. The provider falls back to a hard slice without a text LLM
// (the cheaper path) and to an LLM rewrite when one is wired in.

const longPrompt = "A".repeat(2000);

test("compressPrompt: short prompt is returned as-is (zero cost)", async () => {
  const short = "A short keyframe prompt.";
  const calls: string[] = [];
  const fakeText: AIProvider = {
    generateText: async (p) => {
      calls.push(p);
      return p;
    },
    generateImage: async () => "",
  };
  const out = await compressPrompt(short, 1500, fakeText);
  assert.equal(out, short);
  assert.equal(calls.length, 0, "text LLM must not be called for short prompts");
});

test("compressPrompt: long prompt + no text LLM → hard slice with ellipsis", async () => {
  const out = await compressPrompt(longPrompt, 1500, undefined);
  assert.ok(out.length <= 1500, `length=${out.length}`);
  assert.ok(out.endsWith("..."), "truncation marker should be present");
  assert.equal(out.length, 1500);
});

test("compressPrompt: long prompt + text LLM → returns LLM's rewrite", async () => {
  const compressed = "A shorter, smarter prompt.";
  const fakeText: AIProvider = {
    generateText: async (p) => {
      // The instruction template should mention the limit and the
      // original prompt should be appended after a separator.
      assert.match(p, /1500/, "instruction should mention the 1500 char limit");
      assert.ok(p.includes(longPrompt), "original prompt should be appended");
      return compressed;
    },
    generateImage: async () => "",
  };
  const out = await compressPrompt(longPrompt, 1500, fakeText);
  assert.equal(out, compressed);
});

test("compressPrompt: text LLM still overflows → truncates LLM output", async () => {
  // The LLM tries its best but the rewrite is still over the limit.
  const stillTooLong = "B".repeat(2000);
  const fakeText: AIProvider = {
    generateText: async () => stillTooLong,
    generateImage: async () => "",
  };
  const out = await compressPrompt(longPrompt, 1500, fakeText);
  assert.ok(out.length <= 1500, `length=${out.length}`);
  assert.ok(out.endsWith("..."));
});

test("compressPrompt: text LLM throws → falls back to hard slice", async () => {
  const fakeText: AIProvider = {
    generateText: async () => {
      throw new Error("API down");
    },
    generateImage: async () => "",
  };
  const out = await compressPrompt(longPrompt, 1500, fakeText);
  assert.ok(out.length <= 1500, `length=${out.length}`);
  assert.ok(out.endsWith("..."));
  // Should be the ORIGINAL prompt sliced, not a regenerated one.
  assert.ok(out.startsWith("A".repeat(100)));
});

// ── fetchAnthropicModels: GET /v1/models response parsing ────────────

test("fetchAnthropicModels: parses data[].id from Anthropic response", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    // Verify the request shape: x-api-key + anthropic-version headers
    const req = init as RequestInit;
    const headers = req.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-test-123");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(typeof input, "string");
    assert.match(input as string, /\/v1\/models$/);
    return new Response(
      JSON.stringify({
        data: [
          { id: "claude-haiku-4-5", type: "model", display_name: "Claude Haiku 4.5" },
          { id: "claude-sonnet-4-5", type: "model", display_name: "Claude Sonnet 4.5" },
          { id: "claude-opus-4-7", type: "model", display_name: "Claude Opus 4.7" },
        ],
        has_more: false,
        first_id: "claude-haiku-4-5",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const models = await fetchAnthropicModels("https://api.anthropic.com", "sk-test-123");
    assert.equal(models.length, 3);
    assert.equal(models[0].id, "claude-haiku-4-5");
    assert.equal(models[0].name, "claude-haiku-4-5");
    assert.equal(models[1].id, "claude-sonnet-4-5");
    assert.equal(models[2].id, "claude-opus-4-7");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fetchAnthropicModels: throws on non-2xx response", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
  try {
    await assert.rejects(
      () => fetchAnthropicModels("https://api.anthropic.com", "bad-key"),
      /401/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fetchAnthropicModels: honors custom baseUrl", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(input, "https://proxy.example.com/v1/models");
    return new Response(JSON.stringify({ data: [{ id: "claude-haiku-4-5" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const models = await fetchAnthropicModels("https://proxy.example.com", "key");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "claude-haiku-4-5");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── parseArkImageResponse: ARK /v1/images/generations response ───────

test("parseArkImageResponse: happy path — b64_json in data[0]", () => {
  const json = {
    model: "doubao-seedream-5.0-lite",
    created: 1700000000,
    data: [{ b64_json: "aGVsbG8=", size: "1024x1024" }],
    usage: { generated_images: 1, total_tokens: 4096 },
  };
  const out = parseArkImageResponse(json);
  assert.equal(out.kind, "ok");
  if (out.kind === "ok") {
    assert.equal(out.b64, "aGVsbG8=");
    assert.equal(out.size, "1024x1024");
  }
});

test("parseArkImageResponse: top-level error → kind='error'", () => {
  const json = {
    error: { code: "InvalidParameter", message: "prompt too long" },
  };
  const out = parseArkImageResponse(json);
  assert.equal(out.kind, "error");
  if (out.kind === "error") {
    assert.match(out.message, /prompt too long/);
    assert.equal(out.code, "InvalidParameter");
  }
});

test("parseArkImageResponse: missing b64_json → kind='error'", () => {
  const json = { model: "x", data: [{}] };
  const out = parseArkImageResponse(json);
  assert.equal(out.kind, "error");
  if (out.kind === "error") {
    assert.match(out.message, /b64_json/);
  }
});

test("parseArkImageResponse: empty data array → kind='error'", () => {
  const json = { model: "x", data: [] };
  const out = parseArkImageResponse(json);
  assert.equal(out.kind, "error");
});

test("buildArkImageBody: minimal (prompt only) sets defaults", () => {
  const body = buildArkImageBody({ prompt: "a cat" });
  assert.equal(body.model, "doubao-seedream-5.0-lite");
  assert.equal(body.prompt, "a cat");
  assert.equal(body.response_format, "b64_json");
  assert.equal(body.watermark, false);
  assert.equal(body.image, undefined);
  assert.equal(body.size, undefined);
});

test("buildArkImageBody: with reference images → 'image' field set", () => {
  const body = buildArkImageBody({
    prompt: "transform this",
    referenceImages: ["data:image/png;base64,abc", "data:image/png;base64,def"],
  });
  assert.deepEqual(body.image, ["data:image/png;base64,abc", "data:image/png;base64,def"]);
});

test("buildArkImageBody: with size option → 'size' field set", () => {
  const body = buildArkImageBody({ prompt: "x", size: "2048x2048" });
  assert.equal(body.size, "2048x2048");
});

test("buildArkImageBody: with explicit model → that model wins", () => {
  const body = buildArkImageBody({ prompt: "x", model: "doubao-seedream-4.5" });
  assert.equal(body.model, "doubao-seedream-4.5");
});

// ── buildArkImageUrl: ARK image endpoint construction ──────────────────
// Convention: `baseUrl` carries the `/api/plan/v3` API path prefix
// (same pattern as DashScope's `/api/v1`), and the helper appends
// `/images/generations` to produce the final endpoint. A user who
// pastes the full endpoint URL from the ARK docs into the baseUrl
// field will get the suffix doubled — these tests pin the correct
// construction and the "no double slash on trailing /" case.

test("buildArkImageUrl: baseUrl with /api/plan/v3 → /api/plan/v3/images/generations", () => {
  assert.equal(
    buildArkImageUrl("https://ark.cn-beijing.volces.com/api/plan/v3"),
    "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations",
  );
});

test("buildArkImageUrl: trailing slash on baseUrl is stripped (no double slash)", () => {
  assert.equal(
    buildArkImageUrl("https://ark.cn-beijing.volces.com/api/plan/v3/"),
    "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations",
  );
});

test("buildArkImageUrl: result contains the /images/generations suffix exactly once", () => {
  // Guards against the doubled-path bug class regardless of which
  // baseUrl the user supplied.
  const url = buildArkImageUrl("https://ark.cn-beijing.volces.com/api/plan/v3");
  const occurrences = (url.match(/\/images\/generations/g) || []).length;
  assert.equal(occurrences, 1, `suffix appeared ${occurrences} times in ${url}`);
});

// ── isHttpUrl / mimeFromPath: pure predicates for reference-image
//    conversion in ArkImageProvider. The fs-touching wrapper
//    (`toDataUrlOrUrl` in `ark-image.ts`) delegates to these; the
//    wrapper itself is verified by a manual smoke test because the
//    test runner can't import `ark-image.ts` (it has runtime
//    cross-file imports the strip-types loader can't resolve).

test("isHttpUrl: http and https URLs are recognized", () => {
  assert.equal(isHttpUrl("http://example.com/a.png"), true);
  assert.equal(isHttpUrl("https://cdn.example.com/a.png"), true);
  assert.equal(isHttpUrl("HTTPS://CDN.EXAMPLE.COM/A.PNG"), true);
});

test("isHttpUrl: local file paths and data URIs are NOT treated as http URLs", () => {
  assert.equal(isHttpUrl("/var/uploads/images/abc.png"), false);
  assert.equal(isHttpUrl("./relative/path.jpeg"), false);
  assert.equal(isHttpUrl("uploads/x.webp"), false);
  assert.equal(isHttpUrl("data:image/png;base64,abc"), false);
  assert.equal(isHttpUrl(""), false);
});

test("mimeFromPath: common image extensions map to lowercase mime types", () => {
  // ARK docs require the mime subtype to be lowercase. Pinned here.
  assert.equal(mimeFromPath("/uploads/ref.png"), "image/png");
  assert.equal(mimeFromPath("/uploads/ref.PNG"), "image/png");
  assert.equal(mimeFromPath("/uploads/ref.jpg"), "image/jpeg");
  assert.equal(mimeFromPath("/uploads/ref.jpeg"), "image/jpeg");
  assert.equal(mimeFromPath("/uploads/ref.webp"), "image/webp");
  assert.equal(mimeFromPath("/uploads/ref.gif"), "image/gif");
});

test("mimeFromPath: unknown extension falls back to image/jpeg (the format the ARK provider writes)", () => {
  // The provider saves generated images as `<id>.jpeg` and ARK's seedream
  // models return jpeg by default, so the safe fallback is image/jpeg.
  assert.equal(mimeFromPath("/uploads/ref"), "image/jpeg");
  assert.equal(mimeFromPath("/uploads/ref.unknown"), "image/jpeg");
});

// ── MiniMax video validation: per-docs rules pinned by these tests ────
// Reference: the two endpoints the user pasted
//   - POST /v1/video_generation (image-to-video)
//   - POST /v1/video_generation (start-end-to-video)
// Key constraints:
//   - Keyframe (start-end) mode is `MiniMax-Hailuo-02` ONLY.
//   - 1080P requires duration=6s; 10s is 768P-only.
//   - 512P is I2V-only (Hailuo-02 I2V) — never keyframe.
//   - I2V-01 family supports 720P / 6s only.

test("isKeyframeSupported: only MiniMax-Hailuo-02", () => {
  assert.equal(isKeyframeSupported("MiniMax-Hailuo-02"), true);
  assert.equal(isKeyframeSupported("MiniMax-Hailuo-2.3"), false);
  assert.equal(isKeyframeSupported("MiniMax-Hailuo-2.3-Fast"), false);
  assert.equal(isKeyframeSupported("I2V-01-Director"), false);
  assert.equal(isKeyframeSupported("S2V-01"), false);
});

test("validateMiniMaxVideoRequest: keyframe mode requires MiniMax-Hailuo-02", () => {
  const err = validateMiniMaxVideoRequest({
    model: "MiniMax-Hailuo-2.3",
    mode: "keyframe",
    duration: 6,
    resolution: "768P",
  });
  assert.ok(err && /does not support the start-end/i.test(err), `got: ${err}`);
  assert.ok(err && /MiniMax-Hailuo-02/.test(err), "error should name the supported model");
});

test("validateMiniMaxVideoRequest: Hailuo-02 keyframe is valid", () => {
  assert.equal(
    validateMiniMaxVideoRequest({
      model: "MiniMax-Hailuo-02",
      mode: "keyframe",
      duration: 6,
      resolution: "768P",
    }),
    null,
  );
});

test("validateMiniMaxVideoRequest: subject_ref requires S2V-01", () => {
  const err = validateMiniMaxVideoRequest({
    model: "MiniMax-Hailuo-2.3",
    mode: "subject_ref",
    duration: 6,
    resolution: "768P",
  });
  assert.ok(err && /S2V-01/.test(err), `got: ${err}`);
});

test("validateMiniMaxVideoRequest: Hailuo family 1080P needs duration=6", () => {
  // 10s + 1080P is a forbidden combo per docs.
  const err = validateMiniMaxVideoRequest({
    model: "MiniMax-Hailuo-2.3",
    mode: "i2v",
    duration: 10,
    resolution: "1080P",
  });
  assert.ok(err && /1080P/.test(err), `got: ${err}`);
});

test("validateMiniMaxVideoRequest: I2V-01 family rejects 768P / 1080P", () => {
  // Old I2V-01 family only supports 720P. Catching this client-side
  // gives a clearer error than the API's generic 1026.
  for (const r of ["768P", "1080P"]) {
    const err = validateMiniMaxVideoRequest({
      model: "I2V-01-Director",
      mode: "i2v",
      duration: 6,
      resolution: r,
    });
    assert.ok(err && new RegExp(r).test(err), `${r} on I2V-01 should fail, got: ${err}`);
  }
});

test("allowedResolutionsFor: Hailuo-02 6s I2V includes 512P; keyframe does not", () => {
  // 512P is I2V-only per docs. The keyframe endpoint explicitly says
  // 512P is not supported there.
  const i2v = allowedResolutionsFor("MiniMax-Hailuo-02", 6, { keyframeMode: false });
  assert.ok(i2v.includes("512P"));
  const kf = allowedResolutionsFor("MiniMax-Hailuo-02", 6, { keyframeMode: true });
  assert.ok(!kf.includes("512P"), "keyframe must not include 512P");
});

test("allowedResolutionsFor: 10s is 768P-only across the Hailuo family", () => {
  for (const m of ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast", "MiniMax-Hailuo-02"]) {
    const r = allowedResolutionsFor(m, 10);
    assert.deepEqual([...r], ["768P"], `${m} @ 10s should be 768P-only`);
  }
});

test("allowedResolutionsFor: I2V-01 family is 720P / 6s only", () => {
  for (const m of ["I2V-01-Director", "I2V-01-live", "I2V-01"]) {
    const r6 = allowedResolutionsFor(m, 6);
    assert.deepEqual([...r6], ["720P"]);
    const r10 = allowedResolutionsFor(m, 10);
    assert.deepEqual([...r10], [], `${m} does not support 10s`);
  }
});

test("defaultResolutionFor: docs-default 768P for Hailuo, 720P for I2V-01", () => {
  // Replaces the previously hardcoded "1080P" in minimax-video.ts.
  assert.equal(defaultResolutionFor("MiniMax-Hailuo-2.3", 6), "768P");
  assert.equal(defaultResolutionFor("MiniMax-Hailuo-2.3", 10), "768P");
  assert.equal(defaultResolutionFor("MiniMax-Hailuo-02", 6), "768P");
  assert.equal(defaultResolutionFor("MiniMax-Hailuo-02", 10), "768P");
  assert.equal(defaultResolutionFor("I2V-01-Director", 6), "720P");
});
