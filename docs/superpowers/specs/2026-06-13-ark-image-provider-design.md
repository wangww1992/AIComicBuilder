# ARK (Volcano Engine) Image Provider — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorming complete, awaiting spec user-review → writing-plans)

## Problem

The user wants to add Volcano Engine's ARK image generation API (Doubao Seedream models) as a first-class image-provider option. ARK is the ByteDance equivalent of DashScope: an OpenAI-shaped REST endpoint for hosted image models, with a Chinese-friendly default base URL and the `seedream` model family.

Existing image providers cover: DashScope (Wan/Qwen), Kling, MiniMax. The user is adding ARK alongside them.

## Goals

1. Add ARK as a selectable image-model provider in Settings, alongside existing options
2. Match the existing provider UX: configurable base URL + API key, "获取模型" button that returns a known model list, manual model entry supported
3. Support the Seedream model family (seedream-5.0-lite, 4.5, 4.0, 3.0-t2i) for both text-to-image and image-to-image (with `referenceImages`)

## Non-Goals

- Adding ARK for text or video generation (ARK doesn't compete in the text-generation space we already wire, and video is out of scope)
- Replacing or removing any existing provider
- Pre-selecting a default model other than `doubao-seedream-5.0-lite`
- Supporting the group-image (`sequential_image_generation: "auto"`) flow — single-image output is the right default for storyboard generation; group images are a power-user feature that can be added later
- Dynamic model-list fetching — Volcano Engine does not document a stable `/v1/models` endpoint for image models; we use a static list (matching the pattern for Kling, Wan, DashScope, MiniMax)

## Design

### 1. File structure

| File | Change |
|---|---|
| `src/lib/ai/providers/ark-image.ts` | **New** — ARK image provider class |
| `src/lib/ai/provider-factory.ts` | Add `case "ark"` in `createAIProvider` |
| `src/stores/model-store.ts` | Add `"ark"` to `Protocol` union |
| `src/app/api/models/list/route.ts` | Add `case "ark"` with static Seedream list |
| `src/components/settings/provider-form.tsx` | Add `ark` to `DEFAULT_BASE_URLS` and to the image dropdown |

Naming: `ark-image.ts` matches the existing pattern (`dashscope-image.ts`, `kling-image.ts`, `minimax-image.ts`) — product name, not company domain.

### 2. Protocol + UI label

- **Protocol value:** `"ark"` (string literal, joins the existing union)
- **Settings UI label:** **"火山引擎"** (Chinese brand name; consistent with the existing "百炼 (图片)" / "MiniMax" pattern of mixing Chinese + English in the image dropdown)
- **Capability scope:** image only — not added to `text` or `video` dropdowns

### 3. Default base URL

```ts
DEFAULT_BASE_URLS.ark = "https://ark.cn-beijing.volces.com/api/plan/v3";
```

The existing UI auto-fill logic in `provider-form.tsx:131-137` only overwrites `baseUrl` when the current value is empty OR matches another entry in `DEFAULT_BASE_URLS`. So users who customize their base URL (e.g., to the production `/api/v3` endpoint, or a different region) will have their change preserved when they switch protocols.

### 4. Provider class

`src/lib/ai/providers/ark-image.ts`:

```ts
export class ArkImageProvider implements AIProvider {
  // generateText: throws (ARK doesn't do text generation)

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    const model = options?.model ?? this.model;
    const body: Record<string, unknown> = {
      model,
      prompt,
      response_format: "b64_json",
      watermark: false,
    };
    if (options?.size) body.size = options.size;
    if (options?.referenceImages && options.referenceImages.length > 0) {
      body.image = options.referenceImages.map(toDataUrl);
    }

    const res = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ARK image request failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as ArkImageResponse;
    if (json.error) {
      throw new Error(`ARK image error [${json.error.code ?? "?"}]: ${json.error.message ?? "unknown"}`);
    }
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error(`ARK image: no b64_json in response: ${JSON.stringify(json).slice(0, 200)}`);
    }

    // Save to disk
    const buffer = Buffer.from(b64, "base64");
    const filename = `${genId()}.jpeg`;
    const dir = path.join(this.uploadDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);
    return filepath;
  }
}
```

Behavior choices:
- **`response_format: "b64_json"`** (not `url`): the response includes the image data directly. No follow-up download step, no 24-hour URL expiry risk. The request body is larger, but generation latency dominates.
- **`watermark: false`**: produces clean output suitable for storyboard/comic use. Users can override per-call if we ever expose a UI control.
- **`image` array for i2i**: when `options.referenceImages` is provided, the first item goes into the `image` field. Volcano's API supports 1-14 reference images depending on the model. We pass them all through.
- **Default model**: `doubao-seedream-5.0-lite` (newest, cheapest, supports the most features). Constructor accepts an explicit `model` so the user's manual selection in Settings takes precedence.
- **No `sequential_image_generation`**: single-image output (the default). Group-image mode is a follow-up if ever needed.

### 5. Protocol union + factory

`src/stores/model-store.ts`:
```ts
export type Protocol = "openai" | "gemini" | "seedance" | "ucloud-seedance" | "kling" | "wan" | "dashscope" | "minimax" | "anthropic" | "ark";
```

`src/lib/ai/provider-factory.ts` (inside `createAIProvider`):
```ts
case "ark": {
  return new ArkImageProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.modelId,
    ...(uploadDir && { uploadDir }),
  });
}
```

`createVideoProvider` is **not** modified — ARK image is the only surface this task introduces.

### 6. Static model list

`src/app/api/models/list/route.ts`:
```ts
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
```

Place after the existing `minimax` case, before the generic fallthrough (so the static list short-circuits the generic check). User can also manually add model ids for new Seedream releases before we update this list.

### 7. Settings UI

`src/components/settings/provider-form.tsx`:

```ts
const DEFAULT_BASE_URLS: Record<Protocol, string> = {
  ...,
  anthropic: "https://api.anthropic.com",
  ark: "https://ark.cn-beijing.volces.com/api/plan/v3",
};

function getProtocolOptions(capability: Capability) {
  // text: unchanged
  // image: add to list
  if (capability === "image") {
    return [
      { value: "openai", label: "OpenAI" },
      { value: "gemini", label: "Gemini" },
      { value: "kling", label: "Kling" },
      { value: "dashscope", label: "百炼 (图片)" },
      { value: "minimax", label: "MiniMax" },
      { value: "ark", label: "火山引擎" },  // ← new
    ];
  }
  // video: unchanged
}
```

No new i18n strings needed. "火山引擎" is the brand name in both Chinese and English UIs.

## Data Flow

```
Settings UI
  └─ User adds an Image provider with protocol "ark"
       └─ Fills baseUrl (default https://ark.cn-beijing.volces.com/api/plan/v3) + apiKey
            └─ Clicks "获取模型"
                 └─ POST /api/models/list { protocol: "ark", baseUrl, apiKey }
                      └─ Backend returns the static 4-model Seedream list
                           └─ UI renders the list, user checks the ones they want
                                └─ Saved into model-store

Generation time
  └─ Reads modelConfig.image = { protocol: "ark", baseUrl, apiKey, modelId }
       └─ createAIProvider(config) → new ArkImageProvider(...)
            └─ generateImage(prompt, options)
                 └─ POST {baseUrl}/images/generations
                      └─ b64_json returned in data[0]
                           └─ Decode → save to <uploadDir>/images/<id>.jpeg
                                └─ Return filepath to caller
```

## Error Handling

- **HTTP non-2xx**: caught, error includes status + statusText + first 200 chars of body. Same pattern as the other image providers.
- **Top-level `error` field** in the JSON response: parsed and re-thrown as `ARK image error [code]: message` (so the upstream error code propagates to the UI toast).
- **`b64_json` missing in `data[0]`**: explicit error message naming the response shape.
- **Empty `referenceImages` array**: the `image` field is omitted (sending an empty array is rejected by the upstream).

## Testing

Unit / integration tests (via `node --experimental-strip-types --test`):

The current `src/lib/ai/ai-sdk.test.ts` is set up for pure-helper functions. The ARK provider class is more complex (uses `fs` for file I/O, has state). Two testable units emerge:

1. **A pure response-parsing helper** extracted from the provider (parses `ArkImageResponse` JSON into the data the provider needs). Tests cover happy path, top-level error, missing b64_json, and the i2i case.

2. **The `toDataUrl` helper** (already exists in `minimax-image.ts`; not modified by this task).

The provider class itself is exercised end-to-end via the Settings UI. We don't mock the network in the unit test suite because the existing image providers don't either — they all rely on the smoke test (Task 8).

Manual smoke test (after implementation):
1. `pnpm dev`
2. Settings → Providers → Add Image Provider → "火山引擎"
3. Fill in baseUrl + a real Volcano Engine API key (test keys are available from the [方舟控制台](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey))
4. Click "获取模型" — should list 4 Seedream models
5. Check one → save
6. In a project's storyboard, set the image model to the ARK provider
7. Trigger first-frame generation — should succeed within 10-30s (Seedream is fast for single images)
8. Verify the response is clean (no watermark) and saved to disk
9. Trigger a reference-image generation — verify the `image` field is sent and the upstream accepts it

## Files Touched

| File | Change |
|---|---|
| `src/lib/ai/providers/ark-image.ts` | New file (~100 lines including JSDoc) |
| `src/lib/ai/provider-factory.ts` | Add `case "ark"` (3 lines) |
| `src/stores/model-store.ts` | Add `"ark"` to `Protocol` union (1 line) |
| `src/app/api/models/list/route.ts` | Add `case "ark"` static list (10 lines) |
| `src/components/settings/provider-form.tsx` | Add `DEFAULT_BASE_URLS.ark` + dropdown option (2 lines) |
| `docs/superpowers/specs/2026-06-13-ark-image-provider-design.md` | This spec (new file) |
| `docs/superpowers/plans/2026-06-13-ark-image-provider.md` | Implementation plan (separate task) |

No changes to:
- Other provider classes (text or image)
- Database schema
- i18n files (no new strings — "火山引擎" is the brand name)
- The `extraBody` injection path (no use case for ARK)
- The `compressPrompt` helper (only relevant to text generation)
