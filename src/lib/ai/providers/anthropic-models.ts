/**
 * Fetch the list of available Claude models from an Anthropic-compatible
 * `/v1/models` endpoint. Used by the Settings UI "获取模型" button.
 *
 * Anthropic's API requires:
 *   - `x-api-key` header (NOT `Authorization: Bearer`)
 *   - `anthropic-version` header (pinned to a date; 2023-06-01 is the
 *     current canonical value Anthropic documents)
 *   - `GET /v1/models`
 *
 * We expose `baseUrl` so users with proxies / third-party Anthropic
 * mirrors (e.g. AWS Bedrock, GCP Vertex, private gateways) can configure
 * the endpoint. The implementation is intentionally pure (no
 * `@/`-aliased imports) so `node --experimental-strip-types --test`
 * can import it directly.
 */

export interface ModelItem {
  id: string;
  name: string;
}

interface AnthropicModelsResponse {
  data?: Array<{
    id: string;
    type?: string;
    display_name?: string;
    created_at?: string;
  }>;
  has_more?: boolean;
}

export async function fetchAnthropicModels(
  baseUrl: string,
  apiKey: string,
): Promise<ModelItem[]> {
  // Normalize: strip trailing slashes, then append the canonical path.
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;

  const res = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Anthropic /v1/models failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as AnthropicModelsResponse;
  if (!Array.isArray(json.data)) {
    throw new Error(
      `Anthropic /v1/models: 意外响应格式 (缺少 data 数组): ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  // Use `id` as the display name so the UI shows what the user will
  // actually type into the modelId field. Consistent with how the
  // existing `fetchModels` (openai) maps the same shape.
  return json.data.map((m) => ({ id: m.id, name: m.id }));
}
