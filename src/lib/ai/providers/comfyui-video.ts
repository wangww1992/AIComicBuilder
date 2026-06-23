import fs from "node:fs";
import path from "node:path";
import type { VideoGenerateParams, VideoGenerateResult, VideoProvider } from "../types";
import { ComfyUIClient } from "./comfyui-client";
import { detectOutputNodeId, substitutePlaceholders } from "./comfyui-workflows";
import { db } from "@/lib/db";
import { comfyWorkflows } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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
    const workflowRow = await db
      .select()
      .from(comfyWorkflows)
      .where(eq(comfyWorkflows.id, this.workflowId))
      .limit(1);
    const workflowConfig = workflowRow[0];
    if (!workflowConfig) throw new Error("ComfyUI workflow not found");
    if (workflowConfig.capability !== "video") {
      throw new Error("Selected ComfyUI workflow is not a video workflow");
    }

    const baseWorkflow = JSON.parse(workflowConfig.workflowJson) as Record<string, unknown>;
    const outputNodeId = workflowConfig.outputNodeId ?? detectOutputNodeId(baseWorkflow);
    if (!outputNodeId) throw new Error("ComfyUI workflow has no output node");

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
      placeholderValues.first_frame = await this.client.uploadImage(params.firstFrame);
    }
    if ("lastFrame" in params && params.lastFrame) {
      placeholderValues.last_frame = await this.client.uploadImage(params.lastFrame);
    }
    if (params.referenceImages?.length) {
      const uploaded = await Promise.all(
        params.referenceImages.map((p) => this.client.uploadImage(p)),
      );
      placeholderValues.reference_image = uploaded[0];
      placeholderValues.reference_images = uploaded.join(",");
    }

    let workflow = substitutePlaceholders(baseWorkflow, placeholderValues);
    workflow = await this.uploadLoadImageNodes(workflow);

    const promptId = await this.client.enqueue(workflow);
    const filenames = await this.client.waitForOutput(promptId, outputNodeId);
    const outputFilename = filenames[0];
    const ext = path.extname(outputFilename) || ".mp4";
    const outputPath = path.join(this.uploadDir, "videos", `${genId()}${ext}`);
    await this.client.download(outputFilename, outputPath);
    return { filePath: outputPath };
  }

  private async uploadLoadImageNodes(
    workflow: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [nodeId, node] of Object.entries(workflow)) {
      const typedNode = node as { class_type?: string; inputs?: Record<string, unknown> };
      if (typedNode.class_type === "LoadImage" && typedNode.inputs) {
        const imagePath = typedNode.inputs.image as string | undefined;
        if (imagePath && !imagePath.startsWith("http") && fs.existsSync(imagePath)) {
          typedNode.inputs.image = await this.client.uploadImage(imagePath);
        }
      }
      result[nodeId] = node;
    }
    return result;
  }
}

function parseRatio(ratio: string): [number, number] {
  const parts = ratio.split(":").map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
    const scale = 1024 / parts[0];
    return [Math.round(parts[0] * scale), Math.round(parts[1] * scale)];
  }
  return [1024, 576];
}
