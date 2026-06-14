import type { VideoProvider, VideoGenerateParams, VideoGenerateResult } from "../types";
import {
  defaultResolutionFor,
  validateMiniMaxVideoRequest,
  type MiniMaxVideoMode,
} from "./minimax-video-models";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

// ── Helpers ────────────────────────────────────────────────────────────────

// ARK and the in-house image provider both default the data URI mime
// to `image/jpeg`. We mirror that here so a generated first/last frame
// — saved as `.jpeg` by the image provider — round-trips with the
// right mime subtype and ARK's "mime subtype must be lowercase" rule.
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
          : "image/jpeg";
  const base64 = fs.readFileSync(filePathOrUrl, { encoding: "base64" });
  return `data:${mime};base64,${base64}`;
}

// ── API response shapes ────────────────────────────────────────────────────

interface MiniMaxSubmitResponse {
  task_id?: string;
  base_resp?: { status_code?: number; status_msg?: string };
}

interface MiniMaxQueryResponse {
  status?: "Success" | "Fail" | "Queueing" | "Processing" | string;
  file_id?: string;
  error_message?: string;
  base_resp?: { status_code?: number; status_msg?: string };
}

interface MiniMaxFileRetrieveResponse {
  file?: { download_url?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

// ── Provider ───────────────────────────────────────────────────────────────

export class MiniMaxVideoProvider implements VideoProvider {
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
    this.apiKey = params?.apiKey || process.env.MINIMAX_API_KEY || "";
    this.baseUrl = (
      params?.baseUrl || process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com"
    ).replace(/\/+$/, "");
    this.model =
      params?.model || process.env.MINIMAX_VIDEO_MODEL || "MiniMax-Hailuo-2.3";
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  async generateVideo(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    const body = this.buildBody(params);

    console.log(
      `[MiniMaxVideo] Submitting task: model=${body.model}, duration=${body.duration}, hasFirstFrame=${"first_frame_image" in body}, hasLastFrame=${"last_frame_image" in body}, hasSubjectRef=${"subject_reference" in body}`
    );

    const submit = await fetch(`${this.baseUrl}/v1/video_generation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!submit.ok) {
      const errText = await submit.text().catch(() => "");
      throw new Error(
        `MiniMax video submit failed: ${submit.status} ${errText}`
      );
    }

    const submitResult = (await submit.json()) as MiniMaxSubmitResponse;
    const submitCode = submitResult.base_resp?.status_code;
    if (submitCode !== undefined && submitCode !== 0) {
      throw new Error(
        `MiniMax video submit error [${submitCode}]: ${submitResult.base_resp?.status_msg ?? "unknown"}`
      );
    }
    if (!submitResult.task_id) {
      throw new Error(
        `MiniMax video submit: no task_id in response: ${JSON.stringify(submitResult)}`
      );
    }
    console.log(`[MiniMaxVideo] Task submitted: ${submitResult.task_id}`);

    const downloadUrl = await this.pollForFile(submitResult.task_id);

    const videoRes = await fetch(downloadUrl);
    if (!videoRes.ok) {
      throw new Error(
        `MiniMax video download failed: ${videoRes.status} ${videoRes.statusText}`
      );
    }
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    const filename = `${genId()}.mp4`;
    const dir = path.join(this.uploadDir, "videos");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    return { filePath: filepath };
  }

  /**
   * Build the request body, dispatching to one of the four modes:
   *   - t2v            : prompt only                          (Hailuo family)
   *   - i2v            : first_frame_image + prompt           (Hailuo / I2V-01)
   *   - keyframe       : first_frame + last_frame + prompt    (Hailuo-02 ONLY)
   *   - subject_ref    : subject_reference[].image + prompt   (S2V-01 only)
   *
   * The `S2V-01` model is the only one that understands
   * `subject_reference`; other models reject it. So we only emit that
   * field when the configured model explicitly opts in.
   *
   * Per docs, keyframe mode is supported by `MiniMax-Hailuo-02` ONLY —
   * sending it with `MiniMax-Hailuo-2.3` or any other model produces
   * an API error (1026/2013). We catch that case up front with a
   * user-visible error.
   *
   * Resolution default is `768P` (Hailuo) or `720P` (I2V-01 family)
   * per docs; the previous hardcoded `1080P` would have failed for
   * `Hailuo-02` keyframe + 10s (only `768P` is allowed there).
   */
  private buildBody(params: VideoGenerateParams): Record<string, unknown> {
    const duration = params.duration || 6;
    const mode: MiniMaxVideoMode = this.detectMode(params);
    const resolution = defaultResolutionFor(this.model, duration);

    // Validate up front so a user with the wrong model configured for
    // keyframe mode gets a clear message instead of a cryptic 1026.
    const validationError = validateMiniMaxVideoRequest({
      model: this.model,
      mode,
      duration,
      resolution,
    });
    if (validationError) {
      throw new Error(validationError);
    }

    const base: Record<string, unknown> = {
      model: this.model,
      prompt: params.prompt,
      duration,
      resolution,
    };

    // Mode 3: first + last frame (keyframe). Only MiniMax-Hailuo-02.
    if (mode === "keyframe") {
      const { firstFrame, lastFrame } = params as { firstFrame: string; lastFrame: string };
      base.first_frame_image = toDataUrl(firstFrame);
      base.last_frame_image = toDataUrl(lastFrame);
      return base;
    }

    // Mode 4: subject reference (S2V-01 only). Use the initial image as
    // the first ref and any extras as additional refs.
    if (mode === "subject_ref") {
      const { initialImage, referenceImages = [] } = params as {
        initialImage: string;
        referenceImages?: string[];
      };
      base.subject_reference = [
        {
          type: "character",
          image: [toDataUrl(initialImage), ...referenceImages.map(toDataUrl)],
        },
      ];
      return base;
    }

    // Mode 2: image-to-video (initial frame only).
    if (mode === "i2v") {
      const { initialImage } = params as { initialImage: string };
      base.first_frame_image = toDataUrl(initialImage);
      return base;
    }

    // Mode 1: text-to-video (no images).
    return base;
  }

  /**
   * Pick the request mode from the params. The order matters:
   * keyframe (firstFrame+lastFrame) takes precedence over i2v
   * (initialImage), and subject_ref only applies to S2V-01.
   */
  private detectMode(params: VideoGenerateParams): MiniMaxVideoMode {
    if ("firstFrame" in params && params.firstFrame && params.lastFrame) {
      return "keyframe";
    }
    if (
      this.model === "S2V-01" &&
      "initialImage" in params &&
      params.initialImage &&
      params.referenceImages &&
      params.referenceImages.length > 0
    ) {
      return "subject_ref";
    }
    if ("initialImage" in params && params.initialImage) {
      return "i2v";
    }
    return "t2v";
  }

  private async pollForFile(taskId: string): Promise<string> {
    // MiniMax recommends a 10s poll interval. Cap the total wait at
    // 10 minutes (60 × 10s) to keep the request within sane limits.
    const intervalMs = 10_000;
    const maxAttempts = 60;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      const res = await fetch(
        `${this.baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } }
      );

      if (!res.ok) {
        // Transient — log and keep polling.
        console.warn(
          `[MiniMaxVideo] Poll ${i + 1}: HTTP ${res.status} (retrying)`
        );
        continue;
      }

      const json = (await res.json()) as MiniMaxQueryResponse;
      const status = json.status;
      console.log(`[MiniMaxVideo] Poll ${i + 1}: status=${status}`);

      if (status === "Success" && json.file_id) {
        return await this.retrieveFile(json.file_id);
      }
      if (status === "Fail") {
        throw new Error(
          `MiniMax video generation failed: ${json.error_message ?? "unknown"}`
        );
      }
      // Queueing / Processing / anything else → keep waiting.
    }

    throw new Error("MiniMax video generation timed out after 10 minutes");
  }

  private async retrieveFile(fileId: string): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } }
    );
    if (!res.ok) {
      throw new Error(
        `MiniMax file retrieve failed: ${res.status} ${res.statusText}`
      );
    }
    const json = (await res.json()) as MiniMaxFileRetrieveResponse;
    const url = json.file?.download_url;
    if (!url) {
      throw new Error(
        `MiniMax file retrieve: no download_url: ${JSON.stringify(json)}`
      );
    }
    return url;
  }
}
