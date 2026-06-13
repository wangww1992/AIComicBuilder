# ARK Image Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Volcano Engine ARK (Doubao Seedream) as a first-class image-model provider in the AIComicBuilder Settings, with a static model list, configurable base URL, and `b64_json` response handling including reference-image (i2i) support.

**Architecture:** Dedicated `ArkImageProvider` class following the existing pattern (`DashScopeImageProvider`, `KlingImageProvider`, `MiniMaxImageProvider`) — implements the `AIProvider` interface, uses raw `fetch` against ARK's `POST {baseUrl}/images/generations` endpoint with Bearer auth. A pure response-parsing helper is extracted into a separate file (no `@/` imports) so the existing test runner can unit-test it directly. Wiring goes through the existing `createAIProvider` factory's `protocol` switch.

**Tech Stack:** Vercel AI SDK 6 (consumer of `AIProvider` interface only), Next.js Route Handlers, Zustand store, TypeScript strict mode.

---

## File Structure

| File | Role | Created/Modified |
|---|---|---|
| `src/stores/model-store.ts` | Protocol enum | Modified — add `"ark"` |
| `src/components/settings/provider-form.tsx` | Settings UI | Modified — placeholder URL (Task 1) + real URL + dropdown option (Task 5) |
| `src/lib/ai/provider-factory.ts` | `createAIProvider` factory | Modified — add `case "ark"` |
| `src/lib/ai/providers/ark-models.ts` | Testable ARK response parser + body builder | **New** |
| `src/lib/ai/ai-sdk.test.ts` | Existing test suite | Modified — add parser tests |
| `src/lib/ai/providers/ark-image.ts` | ARK image provider class | **New** |
| `src/app/api/models/list/route.ts` | Model list API route | Modified — add `case "ark"` |
| `docs/superpowers/plans/2026-06-13-ark-image-provider.md` | This plan | New (already exists by the time the tasks run) |

Files change together because they all participate in the same feature surface: a new `Protocol` value flows from the UI down through the store, factory, model-list endpoint, and image-provider class.

---

## Task 1: Add `"ark"` to the Protocol union

**Files:**
- Modify: `src/stores/model-store.ts:5`
- Modify: `src/components/settings/provider-form.tsx:25` (add placeholder to keep `tsc` green)

- [ ] **Step 1: Add the new protocol value to the `Protocol` type**

Edit the `Protocol` type declaration. The line currently reads:

```ts
export type Protocol = "openai" | "gemini" | "seedance" | "ucloud-seedance" | "kling" | "wan" | "dashscope" | "minimax" | "anthropic";
```

Change to:

```ts
export type Protocol = "openai" | "gemini" | "seedance" | "ucloud-seedance" | "kling" | "wan" | "dashscope" | "minimax" | "anthropic" | "ark";
```

This is the only change to `model-store.ts`. `ModelConfig` and `Provider` interfaces reference `Protocol`, so the new value propagates automatically.

- [ ] **Step 2: Add a placeholder to `DEFAULT_BASE_URLS` to keep `tsc` green**

`provider-form.tsx:16-25` declares `DEFAULT_BASE_URLS: Record<Protocol, string>`. After Step 1, this `Record` requires an `ark` key. Add the placeholder in alphabetized position (after `anthropic`):

```ts
const DEFAULT_BASE_URLS: Record<Protocol, string> = {
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  seedance: "https://ark.cn-beijing.volces.com",
  "ucloud-seedance": "https://api.modelverse.cn",
  kling: "https://api.klingai.com",
  wan: "https://dashscope.aliyuncs.com/api/v1",
  dashscope: "https://dashscope.aliyuncs.com/api/v1",
  minimax: "https://api.minimaxi.com",
  anthropic: "https://api.anthropic.com",
  ark: "",
};
```

The `ark: ""` placeholder is required by the type system. Task 5 will replace it with the real default URL `https://ark.cn-beijing.volces.com/api/plan/v3`. **Do not put the real URL here** — Task 5's commit will be the one that introduces the real default, keeping this task's diff minimal and atomic.

- [ ] **Step 3: Type-check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0. The `Record<Protocol, string>` exhaustiveness check now passes thanks to the `ark: ""` placeholder.

- [ ] **Step 4: Commit**

```bash
git add src/stores/model-store.ts src/components/settings/provider-form.tsx
git commit -m "feat(protocol): add ark to Protocol union (placeholder URL)"
```

---

## Task 2: Add the ARK case to `createAIProvider`

**Files:**
- Modify: `src/lib/ai/provider-factory.ts` (add import + new case)

- [ ] **Step 1: Add the import**

At the top of `src/lib/ai/provider-factory.ts`, the existing imports are clustered by `providers/*`. Add this import alphabetically with the other image providers (near `DashScopeImageProvider`):

```ts
import { ArkImageProvider } from "./providers/ark-image";
```

- [ ] **Step 2: Add the new case**

In `createAIProvider`, the `switch` statement has cases for `openai`, `gemini`, `kling`, `dashscope`, `minimax` (the image providers). Add a new case for `ark` after `dashscope` (or wherever fits the file's existing ordering — it doesn't matter functionally):

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

Note: the import in Step 1 references `./providers/ark-image`. The `ArkImageProvider` class doesn't exist yet — it's created in Task 3. The import will fail `tsc` until Task 3 lands. This is intentional (the factory case is small and tightly coupled to the class it instantiates).

- [ ] **Step 3: Type-check (expected to fail until Task 3)**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: **exit non-zero** with error `TS2307: Cannot find module './providers/ark-image'` or similar. This is the expected intermediate state — Task 3 creates the file.

**Do not commit yet.** The TypeScript error is expected. Continue to Task 3.

---

## Task 3: Create the ARK provider class with TDD-extracted response parser

**Files:**
- Create: `src/lib/ai/providers/ark-models.ts` (pure response parser + body builder)
- Modify: `src/lib/ai/ai-sdk.test.ts` (add parser tests)
- Create: `src/lib/ai/providers/ark-image.ts` (provider class)

This task has three sub-steps because (a) the response-parsing logic is complex enough to deserve unit tests, (b) the existing image providers don't have unit tests but the spec explicitly calls for them, and (c) keeping the pure parser separate from the I/O-heavy provider class lets both be tested independently.

### 3a. Write the failing tests for the response parser

- [ ] **Step 1: Add the failing tests**

Open `src/lib/ai/ai-sdk.test.ts`. Add this import at the top with the other provider imports:

```ts
import { parseArkImageResponse, buildArkImageBody } from "./providers/ark-models.ts";
```

Then add these tests after the existing `compressPrompt` / `fetchAnthropicModels` tests (anywhere in the file is fine, but grouping near the parser's test is good for readability):

```ts
// ── parseArkImageResponse: ARK /v1/images/generations response ───────

test("parseArkImageResponse: happy path — b64_json in data[0]", () => {
  const json = {
    model: "doubao-seedream-5.0-lite",
    created: 1700000000,
    data: [{ b64_json: "aGVsbG8=", size: "1024x1024" }],
    usage: { generated_images: 1, total_tokens: 4096 },
  };
  const out = parseArkImageResponse(json);
  assert.equal(out.kind, "ok");
  if (out.kind === "ok") {
    assert.equal(out.b64, "aGVsbG8=");
    assert.equal(out.size, "1024x1024");
  }
});

test("parseArkImageResponse: top-level error → kind='error'", () => {
  const json = {
    error: { code: "InvalidParameter", message: "prompt too long" },
  };
  const out = parseArkImageResponse(json);
  assert.equal(out.kind, "error");
  if (out.kind === "error") {
    assert.match(out.message, /prompt too long/);
    assert.equal(out.code, "InvalidParameter");
  }
});

test("parseArkImageResponse: missing b64_json → kind='error'", () => {
  const json = { model: "x", data: [{}] };
  const out = parseArkImageResponse(json);
  assert.equal(out.kind, "error");
  if (out.kind === "error") {
    assert.match(out.message, /b64_json/);
  }
});

test("parseArkImageResponse: empty data array → kind='error'", () => {
  const json = { model: "x", data: [] };
  const out = parseArkImageResponse(json);
  assert.equal(out.kind, "error");
});

test("buildArkImageBody: minimal (prompt only) sets defaults", () => {
  const body = buildArkImageBody({ prompt: "a cat" });
  assert.equal(body.model, "doubao-seedream-5.0-lite");
  assert.equal(body.prompt, "a cat");
  assert.equal(body.response_format, "b64_json");
  assert.equal(body.watermark, false);
  assert.equal(body.image, undefined);
  assert.equal(body.size, undefined);
});

test("buildArkImageBody: with reference images → 'image' field set", () => {
  const body = buildArkImageBody({
    prompt: "transform this",
    referenceImages: ["data:image/png;base64,abc", "data:image/png;base64,def"],
  });
  assert.deepEqual(body.image, ["data:image/png;base64,abc", "data:image/png;base64,def"]);
});

test("buildArkImageBody: with size option → 'size' field set", () => {
  const body = buildArkImageBody({ prompt: "x", size: "2048x2048" });
  assert.equal(body.size, "2048x2048");
});

test("buildArkImageBody: with explicit model → that model wins", () => {
  const body = buildArkImageBody({ prompt: "x", model: "doubao-seedream-4.5" });
  assert.equal(body.model, "doubao-seedream-4.5");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts 2>&1 | tail -10
```

Expected: 8 test failures with `ERR_MODULE_NOT_FOUND` (or similar) for `./providers/ark-models.ts`. (Correct — we haven't created the file yet.)

### 3b. Create the pure response parser

- [ ] **Step 3: Create `src/lib/ai/providers/ark-models.ts`**

Create the file with this content:

```ts
/**
 * Pure response-parsing and body-building helpers for the Volcano
 * Engine ARK image-generation endpoint.
 *
 * The AI SDK can't call ARK directly (no AI-SDK provider for it), so
 * `ark-image.ts` wraps the raw HTTP. That wrapper is hard to unit-test
 * because it does `fs.writeFileSync` as a side effect. We extract the
 * pure parts (parsing the response JSON, building the request body)
 * into this file so the existing `node --experimental-strip-types
 * --test` runner can hit them directly.
 *
 * No `@/`-aliased imports (see `fetchAnthropicModels` for the same
 * pattern).
 */

// ── Body builder ────────────────────────────────────────────────────────

export interface ArkImageBodyInput {
  prompt: string;
  model?: string;
  size?: string;
  /** Local file paths or http(s) URLs. Pass-through; the upstream
   *  accepts both. */
  referenceImages?: string[];
}

export interface ArkImageBody {
  model: string;
  prompt: string;
  image?: string[];
  size?: string;
  response_format: "b64_json";
  watermark: boolean;
}

export const ARK_DEFAULT_MODEL = "doubao-seedream-5.0-lite";

export function buildArkImageBody(input: ArkImageBodyInput): ArkImageBody {
  const body: ArkImageBody = {
    model: input.model ?? ARK_DEFAULT_MODEL,
    prompt: input.prompt,
    response_format: "b64_json",
    watermark: false,
  };
  if (input.size) body.size = input.size;
  if (input.referenceImages && input.referenceImages.length > 0) {
    body.image = input.referenceImages;
  }
  return body;
}

// ── Response parser ──────────────────────────────────────────────────────

export interface ArkImageOk {
  kind: "ok";
  b64: string;
  size?: string;
}

export interface ArkImageError {
  kind: "error";
  code?: string;
  message: string;
}

export type ArkImageParseResult = ArkImageOk | ArkImageError;

interface ArkImageResponseJson {
  model?: string;
  created?: number;
  data?: Array<{ b64_json?: string; url?: string; size?: string; error?: { code?: string; message?: string } }>;
  usage?: { generated_images?: number; total_tokens?: number };
  error?: { code?: string; message?: string };
}

export function parseArkImageResponse(json: unknown): ArkImageParseResult {
  const j = json as ArkImageResponseJson;

  // 1. Top-level error envelope (auth fail, billing, model not found, etc.)
  if (j.error?.message) {
    return {
      kind: "error",
      code: j.error.code,
      message: j.error.message,
    };
  }

  // 2. Per-image error (mixed-results: one of the requested images failed)
  //    We return that as a top-level error since the spec only requests
  //    a single image per call. (Volcano's response shape: each entry
  //    in `data` can carry its own `error` if the model is asked for
  //    multiple images via `sequential_image_generation: auto`, which we
  //    don't use.)
  if (j.data?.[0]?.error?.message) {
    return {
      kind: "error",
      code: j.data[0].error.code,
      message: j.data[0].error.message,
    };
  }

  // 3. Happy path
  const b64 = j.data?.[0]?.b64_json;
  if (b64) {
    return { kind: "ok", b64, size: j.data?.[0]?.size };
  }

  // 4. Unparseable
  return {
    kind: "error",
    message: `ARK image: no b64_json in response: ${JSON.stringify(j).slice(0, 200)}`,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts 2>&1 | tail -8
```

Expected: 8 new tests pass. Summary line: `pass <N+8> fail 0` where `<N>` is the pre-existing count (currently 26, so should show `pass 34 fail 0`).

### 3c. Create the provider class

- [ ] **Step 5: Create `src/lib/ai/providers/ark-image.ts`**

Create the file:

```ts
import type { AIProvider, TextOptions, ImageOptions } from "../types";
import { buildArkImageBody, parseArkImageResponse, ARK_DEFAULT_MODEL } from "./ark-models";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

/**
 * Volcano Engine ARK image provider. Calls
 *   POST {baseUrl}/images/generations
 * with a Bearer token. Response is parsed by `parseArkImageResponse`
 * (pure helper, unit-tested) and the decoded b64 image is written to
 * `<uploadDir>/images/<id>.jpeg`.
 *
 * The provider is the image-generation side of the surface only — text
 * generation is not supported by ARK and `generateText` throws.
 */
export class ArkImageProvider implements AIProvider {
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
    this.apiKey = params?.apiKey || process.env.ARK_API_KEY || "";
    this.baseUrl = (
      params?.baseUrl || process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com"
    ).replace(/\/+$/, "");
    this.model = params?.model || process.env.ARK_IMAGE_MODEL || ARK_DEFAULT_MODEL;
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  async generateText(_prompt: string, _options?: TextOptions): Promise<string> {
    throw new Error("ARK image models do not support text generation");
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    const body = buildArkImageBody({
      prompt,
      model: options?.model,
      size: options?.size,
      referenceImages: options?.referenceImages,
    });

    const url = `${this.baseUrl}/images/generations`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `ARK image request failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as unknown;
    const parsed = parseArkImageResponse(json);

    if (parsed.kind === "error") {
      throw new Error(
        `ARK image error${parsed.code ? ` [${parsed.code}]` : ""}: ${parsed.message}`,
      );
    }

    // Save decoded image to disk
    const buffer = Buffer.from(parsed.b64, "base64");
    const filename = `${genId()}.jpeg`;
    const dir = path.join(this.uploadDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    return filepath;
  }
}
```

- [ ] **Step 6: Type-check (should now pass; Task 2's import resolves)**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0. The factory import from Task 2 now resolves to the new `ark-image.ts`.

- [ ] **Step 7: Commit (all 3 sub-steps together)**

```bash
git add src/lib/ai/providers/ark-models.ts src/lib/ai/providers/ark-image.ts src/lib/ai/ai-sdk.test.ts
git commit -m "feat(ai): add ARK image provider with response parser + 8 unit tests"
```

---

## Task 4: Add the ARK case to `/api/models/list`

**Files:**
- Modify: `src/app/api/models/list/route.ts` (add `case "ark"`)

- [ ] **Step 1: Add the case branch**

Inside the `POST` function, add a new `if (body.protocol === "ark")` branch. Place it just after the `minimax` block, before the generic `if (!body.baseUrl)` check (so it short-circuits like the other protocol-specific branches):

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

- [ ] **Step 2: Type-check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 3: Smoke-test the endpoint (bogus key exercises the route even though it won't reach ARK)**

```bash
curl -s -X POST http://localhost:3000/api/models/list \
  -H "Content-Type: application/json" \
  -d '{"protocol":"ark","baseUrl":"https://ark.cn-beijing.volces.com/api/plan/v3","apiKey":"sk-fake-for-test"}'
echo ""
```

Expected: a JSON object like:
```json
{"models":[{"id":"doubao-seedream-5.0-lite","name":"Seedream 5.0 Lite"}, ...]}
```

(Unlike the Anthropic branch, this one doesn't call the upstream — it returns the static list directly, so the bogus key doesn't matter.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/models/list/route.ts
git commit -m "feat(api): serve static ARK (Seedream) model list"
```

---

## Task 5: Add ARK to the Settings UI

**Files:**
- Modify: `src/components/settings/provider-form.tsx` (replace placeholder URL + add dropdown option)

- [ ] **Step 1: Replace the placeholder URL with the real default**

In the `DEFAULT_BASE_URLS` map, change the `ark` entry from `""` to:

```ts
const DEFAULT_BASE_URLS: Record<Protocol, string> = {
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  seedance: "https://ark.cn-beijing.volces.com",
  "ucloud-seedance": "https://api.modelverse.cn",
  kling: "https://api.klingai.com",
  wan: "https://dashscope.aliyuncs.com/api/v1",
  dashscope: "https://dashscope.aliyuncs.com/api/v1",
  minimax: "https://api.minimaxi.com",
  anthropic: "https://api.anthropic.com",
  ark: "https://ark.cn-beijing.volces.com/api/plan/v3",
};
```

- [ ] **Step 2: Add the option to the image protocol dropdown**

In `getProtocolOptions`, the `image` case currently returns:

```ts
return [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "kling", label: "Kling" },
  { value: "dashscope", label: "百炼 (图片)" },
  { value: "minimax", label: "MiniMax" },
];
```

Add the ARK option to the bottom of the list:

```ts
return [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "kling", label: "Kling" },
  { value: "dashscope", label: "百炼 (图片)" },
  { value: "minimax", label: "MiniMax" },
  { value: "ark", label: "火山引擎" },
];
```

Do NOT add to the `text` or `video` returns (ARK image is the only surface this task introduces).

- [ ] **Step 3: Type-check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/provider-form.tsx
git commit -m "feat(ui): add 火山引擎 option to image provider dropdown"
```

---

## Task 6: Manual smoke test

No code changes — this is a verification task. The dev server should already be running on port 3000. If not, start it:

```bash
pnpm dev
```

- [ ] **Step 1: Verify the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

Expected: `307` (locale redirect) or `200`.

- [ ] **Step 2: Verify the `Protocol` type now includes `"ark"` and the dropdown contains "火山引擎"**

```bash
grep -n "anthropic\|\"ark\"" /home/wang/codes/AIComicBuilder/src/stores/model-store.ts
grep -n "火山引擎" /home/wang/codes/AIComicBuilder/src/components/settings/provider-form.tsx
```

Expected: both find their respective strings.

- [ ] **Step 3: Verify the `/api/models/list` endpoint returns the static Seedream list**

```bash
curl -s -X POST http://localhost:3000/api/models/list \
  -H "Content-Type: application/json" \
  -d '{"protocol":"ark","baseUrl":"https://ark.cn-beijing.volces.com/api/plan/v3","apiKey":"sk-fake-for-test"}'
echo ""
```

Expected: 4-model Seedream list returned without error.

- [ ] **Step 4: (Optional, requires a real Volcano Engine API key) End-to-end test**

If you have a real ARK API key (obtainable from the [方舟控制台](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)):
1. Open the app in a browser
2. Settings → Providers → Add Image Provider → "火山引擎"
3. Fill in `https://ark.cn-beijing.volces.com/api/plan/v3` + your API key
4. Click "获取模型" — should list 4 Seedream models
5. Check one → save
6. In a project's storyboard, set the image model to the ARK one
7. Click "生成首帧" for a shot — should succeed within 10-30s
8. Verify the response image is clean (no watermark) and saved to disk
9. Trigger a reference-image generation — verify the `image` field is sent

If you don't have a key, **skip this step** and note it in the report.

- [ ] **Step 5: Commit (no-op)**

```bash
git status
```

Expected: clean working tree. (Pre-existing dirty state from prior tasks remains — that's fine, not part of this task.)

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented in |
|---|---|
| §1 file structure | All files accounted for (Tasks 1-5 create/modify exactly the listed files) |
| §2 protocol + UI label | Task 1 (Protocol + placeholder), Task 5 (real URL + dropdown) |
| §3 default baseUrl | Task 5 Step 1 |
| §4 provider class | Task 3c (ArkImageProvider) |
| §5 protocol union + factory | Task 1 (Protocol), Task 2 (factory case) |
| §6 static model list | Task 4 |
| §7 Settings UI | Task 5 |
| §8 untouched files | Verified — no `compressPrompt` / `provider-factory` text branch / `createVideoProvider` changes |
| data-flow section | Covered by the chain Tasks 1-2-3-4-5-6 |
| error-handling section | Task 3c's `parseArkImageResponse` and the throw wrapping |
| testing section (TDD-extracted parser) | Task 3a + 3b (8 unit tests) |
| testing section (smoke test) | Task 6 |

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later" / "fill in details" / "appropriate error handling" — every code step shows the actual code, every command shows expected output.

**3. Type consistency:**
- `Protocol` value `"ark"` defined in Task 1, used in Task 2 (`case "ark"`), Task 4 (route case), Task 5 (dropdown + `DEFAULT_BASE_URLS`) ✓
- `ArkImageBody` / `ArkImageBodyInput` / `parseArkImageResponse` / `buildArkImageBody` / `ARK_DEFAULT_MODEL` all defined in `ark-models.ts` (Task 3b), used in `ark-image.ts` (Task 3c) ✓
- `ArkImageProvider` constructor params `{apiKey, baseUrl, model, uploadDir}` defined in Task 3c, used identically in Task 2's factory case ✓
- `parseArkImageResponse` return shape `{kind: "ok" | "error", ...}` — discriminated union, used in `ArkImageProvider.generateImage` ✓
- `buildArkImageBody` input/output types defined and used consistently within Task 3b/3c ✓
- `ARKBASE_URL` env var name used consistently in Step 5 of Task 3c ✓

**4. Plan size:** 6 tasks, 5 with code changes, 1 with verification. Single coherent feature surface; no decomposition needed.
