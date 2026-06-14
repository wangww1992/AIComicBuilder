/**
 * Pure response-parsing and body-building helpers for the Volcano
 * Engine ARK image-generation endpoint.
 *
 * The AI SDK can't call ARK directly (no AI-SDK provider for it), so
 * `ark-image.ts` wraps the raw HTTP. That wrapper is hard to unit-test
 * because it does `fs.writeFileSync` as a side effect. We extract the
 * pure parts (parsing the response JSON, building the request body)
 * into this file so the existing `node --experimental-strip-types
 * --test` runner can hit them directly.
 *
 * No `@/`-aliased imports (see `fetchAnthropicModels` for the same
 * pattern).
 */

// ── Body builder ────────────────────────────────────────────────────────

export interface ArkImageBodyInput {
  prompt: string;
  model?: string;
  size?: string;
  /** Local file paths or http(s) URLs. Pass-through; the upstream
   *  accepts both. */
  referenceImages?: string[];
}

export interface ArkImageBody {
  model: string;
  prompt: string;
  image?: string[];
  size?: string;
  response_format: "b64_json";
  watermark: boolean;
}

export const ARK_DEFAULT_MODEL = "doubao-seedream-5.0-lite";

/**
 * Build the full URL for an ARK image-generation request. `baseUrl`
 * is expected to be the ARK host with the `/api/plan/v3` API path
 * prefix (e.g. `https://ark.cn-beijing.volces.com/api/plan/v3`); this
 * helper appends `/images/generations` to produce the final endpoint.
 *
 * This convention matches DashScope (`baseUrl` = `…/api/v1`, provider
 * appends the resource path) and is the form the Volcano Engine
 * settings UI defaults to. Do NOT paste the full endpoint URL from
 * the ARK docs into `baseUrl` — that one already ends in
 * `/images/generations` and would be doubled.
 *
 * Pinned by a unit test — do not change the suffix without updating
 * the test.
 */
export function buildArkImageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/generations`;
}

/**
 * `true` for http(s) URLs (case-insensitive scheme). Anything else —
 * local paths, data URIs, empty strings — is treated as a filesystem
 * input by the provider's reference-image conversion. The check is
 * case-insensitive on the scheme so `HTTPS://…` is also recognized.
 */
export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/**
 * Map a file path's extension to a lowercase mime type for use in a
 * `data:<mime>;base64,…` URI. ARK's docs require the mime subtype to
 * be lowercase (e.g. `data:image/png;base64,…`, NOT `data:image/PNG`).
 * Unknown extensions fall back to `image/jpeg` since the ARK provider
 * saves generated images as `.jpeg` and seedream defaults to jpeg
 * output.
 */
export function mimeFromPath(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "tif":
    case "tiff": return "image/tiff";
    case "heic":
    case "heif": return "image/heic";
    default: return "image/jpeg";
  }
}

export function buildArkImageBody(input: ArkImageBodyInput): ArkImageBody {
  const body: ArkImageBody = {
    model: input.model ?? ARK_DEFAULT_MODEL,
    prompt: input.prompt,
    response_format: "b64_json",
    watermark: false,
  };
  if (input.size) body.size = input.size;
  if (input.referenceImages && input.referenceImages.length > 0) {
    body.image = input.referenceImages;
  }
  return body;
}

// ── Response parser ──────────────────────────────────────────────────────

export interface ArkImageOk {
  kind: "ok";
  b64: string;
  size?: string;
}

export interface ArkImageError {
  kind: "error";
  code?: string;
  message: string;
}

export type ArkImageParseResult = ArkImageOk | ArkImageError;

interface ArkImageResponseJson {
  model?: string;
  created?: number;
  data?: Array<{ b64_json?: string; url?: string; size?: string; error?: { code?: string; message?: string } }>;
  usage?: { generated_images?: number; total_tokens?: number };
  error?: { code?: string; message?: string };
}

export function parseArkImageResponse(json: unknown): ArkImageParseResult {
  const j = json as ArkImageResponseJson;

  // 1. Top-level error envelope (auth fail, billing, model not found, etc.)
  if (j.error?.message) {
    return {
      kind: "error",
      code: j.error.code,
      message: j.error.message,
    };
  }

  // 2. Per-image error (mixed-results: one of the requested images failed)
  //    We return that as a top-level error since the spec only requests
  //    a single image per call. (Volcano's response shape: each entry
  //    in `data` can carry its own `error` if the model is asked for
  //    multiple images via `sequential_image_generation: auto`, which we
  //    don't use.)
  if (j.data?.[0]?.error?.message) {
    return {
      kind: "error",
      code: j.data[0].error.code,
      message: j.data[0].error.message,
    };
  }

  // 3. Happy path
  const b64 = j.data?.[0]?.b64_json;
  if (b64) {
    return { kind: "ok", b64, size: j.data?.[0]?.size };
  }

  // 4. Unparseable
  return {
    kind: "error",
    message: `ARK image: no b64_json in response: ${JSON.stringify(j).slice(0, 200)}`,
  };
}
