import { NextResponse } from "next/server";
import { fetchAnthropicModels } from "@/lib/ai/providers/anthropic-models";

interface ListRequest {
  protocol: string;
  baseUrl: string;
  apiKey: string;
}

interface ModelItem {
  id: string;
  name: string;
}

function buildModelsUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, "");
  // If baseUrl already ends with /v1, don't duplicate
  if (url.endsWith("/v1")) {
    return url + "/models";
  }
  return url + "/v1/models";
}

async function fetchModels(baseUrl: string, apiKey: string): Promise<ModelItem[]> {
  const url = buildModelsUrl(baseUrl);
  console.log("[models/list] Fetching:", url);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data?: { id: string }[] };
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("Unexpected response format: missing data array");
  }
  return data.data.map((m) => ({ id: m.id, name: m.id }));
}

async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<ModelItem[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  console.log("[models/list] Fetching Gemini:", url.replace(apiKey, "***"));

  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { models?: { name: string; displayName?: string }[] };
  if (!data.models || !Array.isArray(data.models)) {
    throw new Error("Unexpected Gemini response format: missing models array");
  }
  return data.models.map((m) => {
    const id = m.name.replace(/^models\//, "");
    return { id, name: m.displayName || id };
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ListRequest;

    if (body.protocol === "kling") {
      return NextResponse.json({
        models: [
          { id: "kling-v1", name: "Kling v1" },
          { id: "kling-v1-5", name: "Kling v1.5" },
          { id: "kling-v1-6", name: "Kling v1.6" },
          { id: "kling-v2", name: "Kling v2" },
          { id: "kling-v2-new", name: "Kling v2 New" },
          { id: "kling-v2-1", name: "Kling v2.1" },
          { id: "kling-v2-master", name: "Kling v2 Master" },
          { id: "kling-v2-1-master", name: "Kling v2.1 Master" },
          { id: "kling-v2-5-turbo", name: "Kling v2.5 Turbo" },
        ],
      });
    }

    if (body.protocol === "ucloud-seedance") {
      return NextResponse.json({
        models: [
          { id: "doubao-seedance-1-5-pro-251215", name: "Seedance 1.5 Pro (UCloud)" },
          { id: "doubao-seedance-2-0-260128", name: "Seedance 2.0 (UCloud)" },
        ],
      });
    }

    if (body.protocol === "wan") {
      return NextResponse.json({
        models: [
          { id: "wan2.7-t2v", name: "Wan 2.7 文生视频" },
          { id: "wan2.7-r2v", name: "Wan 2.7 参考生视频" },
          { id: "wan2.6-t2v", name: "Wan 2.6 文生视频" },
          { id: "wan2.6-i2v-flash", name: "Wan 2.6 图生视频 Flash" },
          { id: "wan2.6-i2v", name: "Wan 2.6 图生视频" },
          { id: "wan2.6-r2v", name: "Wan 2.6 参考生视频" },
          { id: "wan2.6-r2v-flash", name: "Wan 2.6 参考生视频 Flash" },
        ],
      });
    }

    if (body.protocol === "dashscope") {
      return NextResponse.json({
        models: [
          { id: "wan2.7-image-pro", name: "Wan 2.7 Image Pro (4K)" },
          { id: "wan2.7-image", name: "Wan 2.7 Image" },
          { id: "qwen-image-2.0-pro", name: "Qwen Image 2.0 Pro" },
          { id: "qwen-image-2.0", name: "Qwen Image 2.0" },
          { id: "qwen-image-max", name: "Qwen Image Max" },
          { id: "qwen-image-plus", name: "Qwen Image Plus" },
          { id: "z-image-turbo", name: "Z-Image Turbo" },
        ],
      });
    }

    if (body.protocol === "minimax") {
      // MiniMax (api.minimaxi.com) does not expose a /v1/models endpoint
      // with the usual OpenAI shape, so we list the documented models
      // here. The user can still type a custom model id into the manual
      // field if a newer one ships before we update this list.
      return NextResponse.json({
        models: [
          // Image
          { id: "image-01", name: "MiniMax image-01" },
          // Video (text-to-video / image-to-video / first-last-frame)
          { id: "MiniMax-Hailuo-2.3", name: "Hailuo 2.3 (T2V / I2V / Keyframe)" },
          { id: "MiniMax-Hailuo-02", name: "Hailuo 02 (T2V / I2V / Keyframe)" },
          // Video (subject-reference, face consistency)
          { id: "S2V-01", name: "Subject Reference v1" },
        ],
      });
    }

    if (body.protocol === "ark") {
      return NextResponse.json({
        models: [
          { id: "doubao-seedream-5.0-lite", name: "Seedream 5.0 Lite" },
          { id: "doubao-seedream-4.5", name: "Seedream 4.5" },
          { id: "doubao-seedream-4.0", name: "Seedream 4.0" },
          { id: "doubao-seedream-3.0-t2i", name: "Seedream 3.0 T2I" },
        ],
      });
    }

    if (body.protocol === "anthropic") {
      if (!body.baseUrl) {
        return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
      }
      if (!body.apiKey) {
        return NextResponse.json({ error: "API Key is required" }, { status: 400 });
      }
      try {
        const models = await fetchAnthropicModels(body.baseUrl, body.apiKey);
        return NextResponse.json({ models });
      } catch (err) {
        // /v1/models can be unavailable on:
        //   - older Anthropic accounts (the endpoint was added in 2024)
        //   - proxies / mirrors that don't implement it
        //   - geo-restricted environments
        // Fall back to a curated list so the user can still configure
        // the provider without losing the rest of the form flow.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[models/list] Anthropic /v1/models failed, using static fallback: ${msg}`);
        return NextResponse.json({
          models: [
            { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
            { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
            { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
            { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku" },
            { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet" },
            { id: "claude-3-opus-latest", name: "Claude 3 Opus" },
          ],
        });
      }
    }

    if (!body.baseUrl) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }
    if (!body.apiKey) {
      return NextResponse.json({ error: "API Key is required" }, { status: 400 });
    }

    const models = body.protocol === "gemini"
      ? await fetchGeminiModels(body.baseUrl, body.apiKey)
      : await fetchModels(body.baseUrl, body.apiKey);
    return NextResponse.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[models/list] Error:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
