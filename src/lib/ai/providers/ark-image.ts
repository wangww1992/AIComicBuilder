import type { AIProvider, TextOptions, ImageOptions } from "../types";
import { buildArkImageBody, parseArkImageResponse, ARK_DEFAULT_MODEL } from "./ark-models";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

/**
 * Volcano Engine ARK image provider. Calls
 *   POST {baseUrl}/images/generations
 * with a Bearer token. Response is parsed by `parseArkImageResponse`
 * (pure helper, unit-tested) and the decoded b64 image is written to
 * `<uploadDir>/images/<id>.jpeg`.
 *
 * The provider is the image-generation side of the surface only — text
 * generation is not supported by ARK and `generateText` throws.
 */
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
      params?.baseUrl || process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com"
    ).replace(/\/+$/, "");
    this.model = params?.model || process.env.ARK_IMAGE_MODEL || ARK_DEFAULT_MODEL;
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  async generateText(_prompt: string, _options?: TextOptions): Promise<string> {
    throw new Error("ARK image models do not support text generation");
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    const body = buildArkImageBody({
      prompt,
      model: options?.model,
      size: options?.size,
      referenceImages: options?.referenceImages,
    });

    const url = `${this.baseUrl}/images/generations`;

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
