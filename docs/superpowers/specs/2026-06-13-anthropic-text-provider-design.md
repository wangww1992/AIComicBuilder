# Anthropic Text Provider — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorming complete, awaiting spec user-review → writing-plans)

## Problem

The user is currently routing `shot_split` (and the rest of the text pipeline: `script_outline`, `script_generate`, `character_extract`) through a MiniMax-M3 endpoint. M3 is a reasoning model whose design centers on chain-of-thought generation. For `shot_split` — a mechanical "split scenes into shots" task — this is a tool-mismatch:

- 7k+ character scripts take 60-180s per chunk even after closing thinking via `thinking: {"type": "disabled"}`
- Each attempt consumes paid reasoning tokens for a task that doesn't benefit from reasoning
- Timeouts at 120s/×2 chunks cascade into user-visible failures

The user wants to add **Anthropic (Claude)** as a first-class text-provider option so they can route text generation through it instead.

## Goals

1. Add Anthropic as a selectable text-model provider in Settings, alongside existing OpenAI and Gemini options
2. Match the existing provider UX: configurable base URL + API key, "获取模型" button that fetches the available model list, manual model entry supported
3. Wire the existing text pipeline (especially `shot_split`) to work with Anthropic without further code changes — except for the `maxOutputTokens` requirement Anthropic enforces

## Non-Goals

- Adding Anthropic for image or video generation (Anthropic doesn't offer these)
- Replacing or removing any existing provider
- Pre-selecting a default Claude model — the user enters the model id manually
- Static fallback list of Claude models when the `/v1/models` endpoint fails (we surface the error and let the user add manually, matching the current pattern for other providers)

## Design

### 1. Package dependency

Add `@ai-sdk/anthropic` to `package.json` dependencies. The user will run `pnpm install` after this change.

```json
"dependencies": {
  ...,
  "@ai-sdk/anthropic": "^1.0.0"
}
```

Use the Vercel AI SDK's official Anthropic provider (consistent with existing `@ai-sdk/openai` and `@ai-sdk/google`). It handles:
- `x-api-key` header auth (Anthropic's scheme, not `Authorization: Bearer`)
- Message-format conversion (Claude's `system` / `messages` shape)
- Token usage reporting (input / output / reasoning if applicable)

### 2. `Protocol` type extension

File: `src/stores/model-store.ts`

```ts
export type Protocol = "openai" | "gemini" | "seedance" | "ucloud-seedance"
                    | "kling" | "wan" | "dashscope" | "minimax" | "anthropic";
```

`ModelConfig.text/image/video` and `Provider` all reference this type, so the new value automatically appears in all consumer types.

### 3. `createLanguageModel` factory

File: `src/lib/ai/ai-sdk.ts`

Add a new `case "anthropic"` to the protocol switch:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";

case "anthropic": {
  const provider = createAnthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
  return provider(config.modelId);
}
```

Note: unlike `createOpenAI().chat(modelId)`, the Anthropic provider is called directly as a function (`provider(modelId)`).

The factory's existing `extraBody` option (used to inject `thinking: {"type": "disabled"}` for MiniMax M3) is harmless for Anthropic — `thinking` is not a recognized field on Claude's wire format and the endpoint will reject it. Since the option is only passed when callers opt in (currently only `shot_split` does so for MiniMax specifically), and the option is set per-config (not per-protocol), it would only reach Anthropic if the user also configured their `text` model as MiniMax AND set `extraBody` — that combination is impossible by construction. The "no-op for Anthropic" case needs no special handling.

### 4. Dynamic model list endpoint

File: `src/app/api/models/list/route.ts`

Add a new `case "anthropic"` branch that:

1. Reads the user's `baseUrl` and `apiKey` from the POST body
2. Calls `GET {baseUrl}/v1/models` with these headers:
   - `x-api-key: {apiKey}`
   - `anthropic-version: 2023-06-01`
3. Parses `data[].id` from the response (each model object has shape `{ id, type: "model", display_name, created_at }`)
4. Returns `NextResponse.json({ models: data.data.map(m => ({ id: m.id, name: m.id })) })` — uses `id` as the display name so it matches the manual-entry convention used by other providers
5. Throws on non-OK HTTP (status, response body) — matches the failure mode of the existing `fetchModels` for openai

No static fallback list. If `/v1/models` fails (e.g., the user's endpoint doesn't support it, or the API key is wrong), the UI shows the error and the user can fall back to manual model entry — same UX as the other providers.

### 5. Settings UI

File: `src/components/settings/provider-form.tsx`

Two changes:

```ts
const DEFAULT_BASE_URLS: Record<Protocol, string> = {
  ...,
  anthropic: "https://api.anthropic.com",
};

function getProtocolOptions(capability: Capability): { value: Protocol; label: string }[] {
  if (capability === "text") {
    return [
      { value: "openai", label: "OpenAI" },
      { value: "gemini", label: "Gemini" },
      { value: "anthropic", label: "Anthropic" },
    ];
  }
  // image and video unchanged — Anthropic doesn't generate either
}
```

The user can:
- Pick "Anthropic" from the text dropdown
- The default base URL auto-fills
- API Key + optional secret key + click "获取模型" → fetches from `/v1/models`
- Or type a model id manually (e.g., `claude-haiku-4-5`) in the manual input

No new i18n strings needed — "Anthropic" is the brand name in both English and Chinese UIs.

### 6. `maxOutputTokens` for shot_split (Anthropic requirement)

Anthropic's `/v1/messages` endpoint **requires** `max_tokens` in the request body. The AI SDK's Anthropic provider maps the standard `maxOutputTokens` option to this field. Without it, every call fails with 400.

File: `src/app/api/projects/[id]/generate/route.ts` — in the shot_split `generateText` call:

```ts
const result = await Promise.race([
  generateText({
    model,
    system: systemPrompt,
    prompt,
    providerOptions: jsonMode,
    abortSignal: abortController.signal,
    maxOutputTokens: 8192,  // ← added
  }),
  timeoutPromise,
]);
```

Why 8192: an 8-scene shot split chunk produces roughly 2000-4000 output tokens (8 × ~300-500 tokens per scene's shot metadata). 8192 leaves comfortable headroom. Harmless for non-Anthropic providers (OpenAI accepts `max_tokens` up to the model's limit, Gemini maps it to its own field).

**Scope**: only `shot_split` gets this change. Other text-pipeline calls (`character_extract`, `script_outline`, `script_generate`, `script_parse`) don't need it for now — they already work with non-Anthropic providers, and Anthropic's default behavior without `maxOutputTokens` will surface as a 400 that the user can then ask us to add it to those paths if/when they switch. Keeping the change minimal reduces blast radius.

If a future need arises to make this global, the cleanest place would be a shared helper in `src/lib/ai/ai-sdk.ts` that the call sites can opt into, rather than scattering the value.

## Data Flow

```
Settings page
  └─ User adds a Text provider with protocol "anthropic"
       └─ Fills baseUrl (default https://api.anthropic.com) + apiKey
            └─ Clicks "获取模型"
                 └─ POST /api/models/list { protocol: "anthropic", baseUrl, apiKey }
                      └─ Backend GETs {baseUrl}/v1/models with x-api-key header
                           └─ Returns [{ id: "claude-haiku-4-5" }, ...]
                                └─ UI renders the list, user checks the ones they want
                                     └─ Saved into model-store

Generation time (shot_split, for example)
  └─ Reads modelConfig.text = { protocol: "anthropic", baseUrl, apiKey, modelId }
       └─ createLanguageModel(config) → @ai-sdk/anthropic provider(modelId)
            └─ generateText({ model, system, prompt, maxOutputTokens: 8192, abortSignal, providerOptions })
                 └─ Anthropic provider → POST {baseUrl}/v1/messages
                      └─ Streams / returns full response
                           └─ AI SDK returns GenerateTextResult
                                └─ Route parses result.text via extractJSON → JSON.parse
```

## Error Handling

- **`/v1/models` fails** (e.g., bad API key, endpoint doesn't support it): the existing `fetchModels` pattern throws. The route returns 502 with the error message. The UI displays the error in the existing `fetchError` slot. The user can fall back to manual model entry.

- **`generateText` 400 (missing `maxOutputTokens`)**: caught by the existing `try/catch` in the shot_split Promise.all map. Emits `chunk_error` event with the message. Client displays it via the existing toast.

- **`generateText` non-2xx** (e.g., 401 unauthorized, 429 rate limit): same path as above — caught, emitted as `chunk_error`, retried/aborted per existing logic.

- **`abortController` triggers** (timeout, peer chunk failed): same as current. Other in-flight chunks abort, stream closes, `error` event fires.

## Testing

Unit / integration tests (via `node --experimental-strip-types --test`):

1. Add a test to verify the `/api/models/list` route correctly handles the `protocol: "anthropic"` request shape and parses the `/v1/models` response. Mock the upstream fetch.

2. Existing `extractJSON` and `stripThinking` tests stay unchanged — they don't care about the provider.

Manual smoke test (after implementation):

1. `pnpm install` (adds `@ai-sdk/anthropic`)
2. `pnpm dev`
3. Settings → Add Text Provider → Anthropic → fill in baseUrl + a real Anthropic API key
4. Click "获取模型" → confirm Claude models appear in the list
5. Check one or two → save
6. Trigger `shot_split` (or `script_outline`) with an Anthropic model — confirm response comes back
7. Verify the response is fast (5-15s, not 60-180s) and tokens are reported

## Files Touched

| File | Change |
|---|---|
| `package.json` | Add `@ai-sdk/anthropic` dependency |
| `src/stores/model-store.ts` | Add `"anthropic"` to `Protocol` union |
| `src/lib/ai/ai-sdk.ts` | Add `case "anthropic"` in `createLanguageModel` |
| `src/app/api/models/list/route.ts` | Add `case "anthropic"` with `GET /v1/models` fetch |
| `src/components/settings/provider-form.tsx` | Add to `DEFAULT_BASE_URLS` and `getProtocolOptions("text")` |
| `src/app/api/projects/[id]/generate/route.ts` | Add `maxOutputTokens: 8192` to shot_split `generateText` call |
| `docs/superpowers/specs/2026-06-13-anthropic-text-provider-design.md` | This spec (new file) |

No changes to:
- `src/lib/ai/providers/*` (no new provider class file — Anthropic uses the Vercel AI SDK directly)
- Database schema
- i18n files (no new strings — brand name)
- `createVideoProvider` or image/video paths
