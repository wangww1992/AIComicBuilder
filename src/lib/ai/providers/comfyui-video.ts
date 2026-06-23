import path from "node:path";
import type { VideoGenerateParams, VideoGenerateResult, VideoProvider } from "../types";
import { ComfyUIClient } from "./comfyui-client";
import {
  loadComfyUIWorkflow,
  parseRatio,
  substitutePlaceholders,
  uploadImagePath,
  uploadLoadImageNodes,
} from "./comfyui-workflows";
import { id as genId } from "@/lib/id";

interface ComfyUIVideoProviderParams {
  baseUrl: string;
  workflowId: string;
  uploadDir: string;
}

export class ComfyUIVideoProvider implements VideoProvider {
  private client: ComfyUIClient;
  private workflowId: string;
  private uploadDir: string;

  constructor(params: ComfyUIVideoProviderParams) {
    this.client = new ComfyUIClient(params.baseUrl);
    this.workflowId = params.workflowId;
    this.uploadDir = params.uploadDir;
  }

  async generateVideo(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    const { baseWorkflow, outputNodeId } = await loadComfyUIWorkflow(
      this.workflowId,
      "video",
    );

    const [width, height] = parseRatio(params.ratio);
    const placeholderValues: Record<string, string> = {
      prompt: params.prompt,
      negative_prompt: "",
      duration: String(params.duration),
      seed: String(Math.floor(Math.random() * 1_000_000_000)),
      width: String(width),
      height: String(height),
    };

    if ("firstFrame" in params && params.firstFrame) {
      placeholderValues.first_frame = await uploadImagePath(this.client, params.firstFrame);
    }
    if ("lastFrame" in params && params.lastFrame) {
      placeholderValues.last_frame = await uploadImagePath(this.client, params.lastFrame);
    }
    if ("initialImage" in params && params.initialImage) {
      placeholderValues.initial_image = await uploadImagePath(this.client, params.initialImage);
    }
    if (params.referenceImages?.length) {
      const uploaded = await Promise.all(
        params.referenceImages.map((p) => uploadImagePath(this.client, p)),
      );
      placeholderValues.reference_image = uploaded[0];
      placeholderValues.reference_images = uploaded.join(",");
    }

    let workflow = substitutePlaceholders(baseWorkflow, placeholderValues);
    workflow = await uploadLoadImageNodes(workflow, this.client);

    const promptId = await this.client.enqueue(workflow);
    const filenames = await this.client.waitForOutput(promptId, outputNodeId);
    const outputFilename = filenames[0];
    const ext = path.extname(outputFilename) || ".mp4";
    const outputPath = path.join(this.uploadDir, "videos", `${genId()}${ext}`);
    await this.client.download(outputFilename, outputPath);
    return { filePath: outputPath };
  }
}
