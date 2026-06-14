import type { AIProvider, TextOptions, ImageOptions } from "../types";
import {
  buildArkImageBody,
  buildArkImageUrl,
  isHttpUrl,
  mimeFromPath,
  parseArkImageResponse,
  ARK_DEFAULT_MODEL,
} from "./ark-models";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

/**
 * Volcano Engine ARK image provider. Calls
 *   POST {baseUrl}/images/generations
 * with a Bearer token. `baseUrl` is expected to be the ARK host with
 * the `/api/plan/v3` API path prefix — same convention as DashScope
 * (whose `baseUrl` carries `/api/v1`). The default baseUrl is
 * `https://ark.cn-beijing.volces.com/api/plan/v3`, which yields the
 * working endpoint `…/api/plan/v3/images/generations`. Do NOT paste
 * the full endpoint URL from the ARK docs into the baseUrl field —
 * that one already ends in `/images/generations` and would be doubled.
 *
 * The `image` field of the request body (used for image-to-image and
 * multi-image fusion) accepts http(s) URLs or `data:<mime>;base64,…`
 * data URIs. The pipeline passes local file paths in, so this
 * provider reads and base64-encodes them via `toDataUrlOrUrl` before
 * sending. The ARK docs require the mime subtype to be lowercase
 * (e.g. `data:image/png;base64,…`).
 *
 * Response is parsed by `parseArkImageResponse` (pure helper,
 * unit-tested) and the decoded b64 image is written to
 * `<uploadDir>/images/<id>.jpeg`.
 *
 * The provider is the image-generation side of the surface only — text
 * generation is not supported by ARK and `generateText` throws.
 */

// Default baseUrl must include the `/api/plan/v3` API path prefix
// (see class JSDoc above). Kept in sync with the settings form default.
const ARK_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

/**
 * Convert a reference-image input (local file path OR http(s) URL) to
 * the form ARK's `image` field accepts. URLs are passed through;
 * local files are read and embedded as a `data:<mime>;base64,…` URI.
 * The URL/mime predicates are pure exports of `ark-models.ts`; this
 * wrapper is the only fs-touching part. Kept per-provider because
 * other upstreams may diverge (e.g. only accept URLs, not data URIs).
 */
function toDataUrlOrUrl(input: string): string {
  if (isHttpUrl(input)) return input;
  const mime = mimeFromPath(input);
  const base64 = fs.readFileSync(input, { encoding: "base64" });
  return `data:${mime};base64,${base64}`;
}

export class ArkImageProvider implements AIProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private uploadDir: string;

  constructor(params?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    uploadDir?: string;
  }) {
    this.apiKey = params?.apiKey || process.env.ARK_API_KEY || "";
    this.baseUrl = (
      params?.baseUrl || process.env.ARK_BASE_URL || ARK_DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    this.model = params?.model || process.env.ARK_IMAGE_MODEL || ARK_DEFAULT_MODEL;
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  async generateText(_prompt: string, _options?: TextOptions): Promise<string> {
    throw new Error("ARK image models do not support text generation");
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    // Convert each reference image (local path or URL) to the form
    // ARK accepts. Without this, a local path like
    // `/var/uploads/abc.jpeg` reaches ARK verbatim and the API
    // rejects it with `image: invalid url specified`.
    const referenceImages = options?.referenceImages?.map(toDataUrlOrUrl);

    const body = buildArkImageBody({
      prompt,
      model: options?.model,
      size: options?.size,
      referenceImages,
    });

    const url = buildArkImageUrl(this.baseUrl);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `ARK image request failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as unknown;
    const parsed = parseArkImageResponse(json);

    if (parsed.kind === "error") {
      throw new Error(
        `ARK image error${parsed.code ? ` [${parsed.code}]` : ""}: ${parsed.message}`,
      );
    }

    // Save decoded image to disk
    const buffer = Buffer.from(parsed.b64, "base64");
    const filename = `${genId()}.jpeg`;
    const dir = path.join(this.uploadDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    return filepath;
  }
}
