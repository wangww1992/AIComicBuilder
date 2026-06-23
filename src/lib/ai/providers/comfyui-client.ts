import fs from "node:fs";
import path from "node:path";

interface QueueResponse {
  prompt_id: string;
}

interface HistoryEntry {
  status?: { completed?: boolean; status_str?: string };
  outputs?: Record<string, { images?: Array<{ filename: string }>; videos?: Array<{ filename: string }> }>;
}

export class ComfyUIClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async uploadImage(filePath: string): Promise<string> {
    const form = new FormData();
    const blob = new Blob([fs.readFileSync(filePath)]);
    form.append("image", blob, path.basename(filePath));
    const res = await fetch(this.url("/upload/image"), {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw new Error(`ComfyUI upload failed: ${await res.text()}`);
    const data = (await res.json()) as { name: string };
    return data.name;
  }

  async enqueue(workflow: Record<string, unknown>): Promise<string> {
    const res = await fetch(this.url("/prompt"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ prompt: workflow }),
    });
    if (!res.ok) throw new Error(`ComfyUI enqueue failed: ${await res.text()}`);
    const data = (await res.json()) as QueueResponse;
    return data.prompt_id;
  }

  async waitForOutput(
    promptId: string,
    outputNodeId: string,
    timeoutMs = 300_000,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    const interval = 1000;
    while (Date.now() < deadline) {
      const res = await fetch(this.url(`/history/${promptId}`), { headers: this.authHeaders() });
      if (!res.ok) throw new Error(`ComfyUI history fetch failed: ${await res.text()}`);
      const data = (await res.json()) as Record<string, HistoryEntry>;
      const entry = data[promptId];
      if (entry?.status?.status_str === "error") {
        throw new Error(`ComfyUI execution failed: ${entry.status.status_str}`);
      }
      if (entry?.outputs?.[outputNodeId]) {
        const node = entry.outputs[outputNodeId];
        const files = [
          ...(node.images ?? []),
          ...(node.videos ?? []),
        ].map((f) => f.filename);
        if (files.length > 0) return files;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("ComfyUI generation timed out");
  }

  async download(filename: string, outputPath: string): Promise<void> {
    const res = await fetch(this.url(`/view?filename=${encodeURIComponent(filename)}`), {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`ComfyUI download failed for ${filename}`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
  }
}
