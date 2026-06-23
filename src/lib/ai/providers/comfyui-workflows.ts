import fs from "node:fs";
import { ComfyUIClient } from "./comfyui-client.ts";

export function detectOutputNodeId(workflow: Record<string, unknown>): string | null {
  const outputClassTypes = ["SaveImage", "VHS_VideoCombine", "SaveVideo"];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const classType = (node as { class_type?: string }).class_type;
    if (classType && outputClassTypes.includes(classType)) {
      return nodeId;
    }
  }
  return null;
}

export function substitutePlaceholders(
  workflow: Record<string, unknown>,
  values: Record<string, string>,
): Record<string, unknown> {
  let json = JSON.stringify(workflow);
  for (const [key, value] of Object.entries(values)) {
    json = json.split(`{{${key}}}`).join(value);
  }
  return JSON.parse(json) as Record<string, unknown>;
}

export function parseRatio(ratio: string): [number, number] {
  const parts = ratio.split(":").map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
    const scale = 1024 / parts[0];
    return [Math.round(parts[0] * scale), Math.round(parts[1] * scale)];
  }
  return [1024, 576];
}

export function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export async function uploadImagePath(
  client: ComfyUIClient,
  imagePath: string,
): Promise<string> {
  if (isUrl(imagePath)) return imagePath;
  return client.uploadImage(imagePath);
}

export async function uploadLoadImageNodes(
  workflow: Record<string, unknown>,
  client: ComfyUIClient,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(workflow)) {
    const typedNode = node as { class_type?: string; inputs?: Record<string, unknown> };
    if (typedNode.class_type === "LoadImage" && typedNode.inputs) {
      const imagePath = typedNode.inputs.image as string | undefined;
      if (imagePath && !isUrl(imagePath) && fs.existsSync(imagePath)) {
        typedNode.inputs.image = await client.uploadImage(imagePath);
      }
    }
    result[nodeId] = node;
  }
  return result;
}

