import fs from "node:fs";
import path from "node:path";
import type { AIProvider, ImageOptions, TextOptions } from "../types";
import { ComfyUIClient } from "./comfyui-client";
import { detectOutputNodeId, substitutePlaceholders } from "./comfyui-workflows";
import { db } from "@/lib/db";
import { comfyWorkflows } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { id as genId } from "@/lib/id";

interface ComfyUIImageProviderParams {
  baseUrl: string;
  workflowId: string;
  uploadDir: string;
}

export class ComfyUIImageProvider implements AIProvider {
  private client: ComfyUIClient;
  private workflowId: string;
  private uploadDir: string;

  constructor(params: ComfyUIImageProviderParams) {
    this.client = new ComfyUIClient(params.baseUrl);
    this.workflowId = params.workflowId;
    this.uploadDir = params.uploadDir;
  }

  async generateText(_prompt: string, _options?: TextOptions): Promise<string> {
    throw new Error("ComfyUIImageProvider does not support text generation");
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    const workflowRow = await db
      .select()
      .from(comfyWorkflows)
      .where(eq(comfyWorkflows.id, this.workflowId))
      .limit(1);
    const workflowConfig = workflowRow[0];
    if (!workflowConfig) throw new Error("ComfyUI workflow not found");
    if (workflowConfig.capability !== "image") {
      throw new Error("Selected ComfyUI workflow is not an image workflow");
    }

    const baseWorkflow = JSON.parse(workflowConfig.workflowJson) as Record<string, unknown>;
    const outputNodeId = workflowConfig.outputNodeId ?? detectOutputNodeId(baseWorkflow);
    if (!outputNodeId) throw new Error("ComfyUI workflow has no output node");

    const placeholderValues: Record<string, string> = {
      prompt,
      negative_prompt: "",
      seed: String(Math.floor(Math.random() * 1_000_000_000)),
    };

    if (options?.referenceImages?.length) {
      const uploaded = await Promise.all(
        options.referenceImages.map((p) => this.client.uploadImage(p)),
      );
      placeholderValues.reference_image = uploaded[0];
      placeholderValues.reference_images = uploaded.join(",");
    }

    const [width, height] = parseRatio(options?.aspectRatio ?? "16:9");
    placeholderValues.width = String(width);
    placeholderValues.height = String(height);

    let workflow = substitutePlaceholders(baseWorkflow, placeholderValues);
    workflow = await this.uploadLoadImageNodes(workflow);

    const promptId = await this.client.enqueue(workflow);
    const filenames = await this.client.waitForOutput(promptId, outputNodeId);
    const outputFilename = filenames[0];
    const outputPath = path.join(this.uploadDir, "frames", `${genId()}.png`);
    await this.client.download(outputFilename, outputPath);
    return outputPath;
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
