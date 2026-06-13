# Anthropic Text Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Anthropic (Claude) as a first-class text-model provider in the AIComicBuilder Settings, with dynamic model listing via Anthropic's `/v1/models` endpoint and proper `maxOutputTokens` handling for `shot_split`.

**Architecture:** Use Vercel AI SDK's official `@ai-sdk/anthropic` provider (consistent with existing `@ai-sdk/openai` and `@ai-sdk/google`). Add a new `"anthropic"` protocol value through the type system, factory, model-list endpoint, and Settings UI. Inject `maxOutputTokens: 8192` in the `shot_split` call site to satisfy Anthropic's required `max_tokens` field.

**Tech Stack:** Vercel AI SDK (`@ai-sdk/anthropic`), Next.js Route Handlers, Zustand store, TypeScript strict mode.

---

## File Structure

| File | Role | Created/Modified |
|---|---|---|
| `package.json` | Dependency manifest | Modified — add `@ai-sdk/anthropic` |
| `src/stores/model-store.ts` | Protocol enum | Modified — add `"anthropic"` |
| `src/lib/ai/ai-sdk.ts` | `createLanguageModel` factory | Modified — add Anthropic case |
| `src/lib/ai/providers/anthropic-models.ts` | Testable Anthropic `/v1/models` fetcher | **New** |
| `src/lib/ai/ai-sdk.test.ts` | Existing test suite | Modified — add Anthropic fetcher test |
| `src/app/api/models/list/route.ts` | Model list API route | Modified — add Anthropic branch |
| `src/components/settings/provider-form.tsx` | Settings UI | Modified — default URL + dropdown option |
| `src/app/api/projects/[id]/generate/route.ts` | Generation pipeline | Modified — add `maxOutputTokens` to shot_split |

Files change together because they all participate in the same feature surface: a new protocol value flows from the UI down through the store, factory, and API call sites.

---

## Task 1: Add @ai-sdk/anthropic dependency

**Files:**
- Modify: `package.json` (add to `dependencies`)
- (Generated): `pnpm-lock.yaml`

- [ ] **Step 1: Add the dependency to package.json**

Edit `package.json`. In the `dependencies` block, add the new line. Keep entries alphabetized where they currently are.

```json
"@ai-sdk/anthropic": "^1.0.0",
```

Place it before `"@ai-sdk/google"` (the existing `@ai-sdk/*` entries are alphabetized).

- [ ] **Step 2: Install**

```bash
pnpm install
```

Expected: `+ @ai-sdk/anthropic 1.x.x` appears in the output, no errors.

- [ ] **Step 3: Verify the package is importable**

```bash
node -e "import('@ai-sdk/anthropic').then(m => console.log(typeof m.createAnthropic))"
```

Expected: `function` (printed without error).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: add @ai-sdk/anthropic"
```

---

## Task 2: Add "anthropic" to the Protocol union

**Files:**
- Modify: `src/stores/model-store.ts:5`

- [ ] **Step 1: Add the new protocol value**

Edit the `Protocol` type declaration. The line currently reads:

```ts
export type Protocol = "openai" | "gemini" | "seedance" | "ucloud-seedance" | "kling" | "wan" | "dashscope" | "minimax";
```

Change to:

```ts
export type Protocol = "openai" | "gemini" | "seedance" | "ucloud-seedance" | "kling" | "wan" | "dashscope" | "minimax" | "anthropic";
```

This is the only change in the file for this task. The `ModelConfig` and `Provider` interfaces (lines 30-33) reference `Protocol`, so the new value automatically propagates.

- [ ] **Step 2: Type-check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0, no errors. (The new value is a string literal added to a union; nothing else should break.)

- [ ] **Step 3: Commit**

```bash
git add src/stores/model-store.ts
git commit -m "feat(protocol): add anthropic to Protocol union"
```

---

## Task 3: Add the Anthropic case to createLanguageModel

**Files:**
- Modify: `src/lib/ai/ai-sdk.ts` (add import + new case)

- [ ] **Step 1: Add the import**

At the top of `src/lib/ai/ai-sdk.ts`, add this import (alphabetized, just below `@ai-sdk/openai`):

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
```

- [ ] **Step 2: Add the new case**

In `createLanguageModel`, the `switch` statement currently has `case "openai"` and `case "gemini"`. Add a new case for anthropic between them (or after — position doesn't matter functionally):

```ts
case "anthropic": {
  const provider = createAnthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
  return provider(config.modelId);
}
```

- [ ] **Step 3: Type-check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0. If you get "Cannot find module '@ai-sdk/anthropic'", Task 1's `pnpm install` didn't complete — re-run it.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/ai-sdk.ts
git commit -m "feat(ai-sdk): add anthropic case in createLanguageModel"
```

---

## Task 4: Extract and test the Anthropic model fetcher (TDD)

This is the one place in the feature where TDD pays off: the `/v1/models` response parsing is the only pure-logic chunk that doesn't depend on the full Next.js runtime. We extract it into its own file (no `@/` imports) so the existing test runner (`node --experimental-strip-types --test`) can import it.

**Files:**
- Create: `src/lib/ai/providers/anthropic-models.ts`
- Modify: `src/lib/ai/ai-sdk.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Open `src/lib/ai/ai-sdk.test.ts` and add this import at the top with the others:

```ts
import { fetchAnthropicModels } from "./providers/anthropic-models.ts";
```

Then add these tests after the existing `compressPrompt` tests (just before the closing of the file):

```ts
// ── fetchAnthropicModels: GET /v1/models response parsing ────────────

test("fetchAnthropicModels: parses data[].id from Anthropic response", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    // Verify the request shape: x-api-key + anthropic-version headers
    const req = init as RequestInit;
    const headers = req.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-test-123");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(typeof input, "string");
    assert.match(input as string, /\/v1\/models$/);
    return new Response(
      JSON.stringify({
        data: [
          { id: "claude-haiku-4-5", type: "model", display_name: "Claude Haiku 4.5" },
          { id: "claude-sonnet-4-5", type: "model", display_name: "Claude Sonnet 4.5" },
          { id: "claude-opus-4-7", type: "model", display_name: "Claude Opus 4.7" },
        ],
        has_more: false,
        first_id: "claude-haiku-4-5",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const models = await fetchAnthropicModels("https://api.anthropic.com", "sk-test-123");
    assert.equal(models.length, 3);
    assert.equal(models[0].id, "claude-haiku-4-5");
    assert.equal(models[0].name, "claude-haiku-4-5");
    assert.equal(models[1].id, "claude-sonnet-4-5");
    assert.equal(models[2].id, "claude-opus-4-7");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fetchAnthropicModels: throws on non-2xx response", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
  try {
    await assert.rejects(
      () => fetchAnthropicModels("https://api.anthropic.com", "bad-key"),
      /401/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fetchAnthropicModels: honors custom baseUrl", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(input, "https://proxy.example.com/v1/models");
    return new Response(JSON.stringify({ data: [{ id: "claude-haiku-4-5" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const models = await fetchAnthropicModels("https://proxy.example.com", "key");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "claude-haiku-4-5");
  } finally {
    globalThis.fetch = origFetch;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts 2>&1 | tail -20
```

Expected: 3 test failures, all complaining that `fetchAnthropicModels` is not exported from `./providers/anthropic-models.ts`. (This is correct — we haven't created the file yet.)

- [ ] **Step 3: Create the fetcher module**

Create the new file `src/lib/ai/providers/anthropic-models.ts` with this content:

```ts
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
      `Anthropic /v1/models: unexpected response format (missing data array): ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  // Use `id` as the display name so the UI shows what the user will
  // actually type into the modelId field. Consistent with how the
  // existing `fetchModels` (openai) maps the same shape.
  return json.data.map((m) => ({ id: m.id, name: m.id }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts 2>&1 | tail -8
```

Expected: all 21 tests pass (18 prior + 3 new). The summary line should read `pass 21 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/providers/anthropic-models.ts src/lib/ai/ai-sdk.test.ts
git commit -m "feat(ai): add Anthropic model-list fetcher with tests"
```

---

## Task 5: Add the Anthropic case to the /api/models/list route

**Files:**
- Modify: `src/app/api/models/list/route.ts` (add import + new `case "anthropic"`)

- [ ] **Step 1: Add the import**

At the top of the route file, add:

```ts
import { fetchAnthropicModels } from "@/lib/ai/providers/anthropic-models";
```

Place it with the other `@/lib/ai/...` imports. (This is fine for a Next.js route — the test runner won't be loading this file, and the `@/` alias is configured in `tsconfig.json` for the Next build.)

- [ ] **Step 2: Add the case branch**

Inside the `POST` function, add a new `if (body.protocol === "anthropic")` branch. Place it just before the `if (!body.baseUrl)` check (so it short-circuits like the other protocol-specific branches do).

```ts
if (body.protocol === "anthropic") {
  if (!body.baseUrl) {
    return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
  }
  if (!body.apiKey) {
    return NextResponse.json({ error: "API Key is required" }, { status: 400 });
  }
  const models = await fetchAnthropicModels(body.baseUrl, body.apiKey);
  return NextResponse.json({ models });
}
```

- [ ] **Step 3: Type-check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 4: Verify the endpoint responds (with a real key would be best; a bogus key exercises the error path)**

```bash
# This will return 502 because the key is fake, but it proves the
# route reached our fetcher and propagated the error correctly.
curl -s -X POST http://localhost:3000/api/models/list \
  -H "Content-Type: application/json" \
  -d '{"protocol":"anthropic","baseUrl":"https://api.anthropic.com","apiKey":"sk-fake-for-test"}' \
  | head -c 300
```

Expected: a JSON object containing an `error` field mentioning Anthropic / 401. If you see the request hit the route (it should be fast), the wiring works. (If you get "fetch failed" with DNS errors, the dev server is probably down — restart with `pnpm dev` and retry.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/models/list/route.ts
git commit -m "feat(api): serve Anthropic model list via /v1/models"
```

---

## Task 6: Add Anthropic to the Settings UI

**Files:**
- Modify: `src/components/settings/provider-form.tsx` (two changes)

- [ ] **Step 1: Add the default base URL**

The `DEFAULT_BASE_URLS` map at the top of the file currently has 8 entries. Add a new line for `anthropic`:

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
};
```

- [ ] **Step 2: Add the option to the text protocol dropdown**

In `getProtocolOptions`, the `text` case currently returns:

```ts
return [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
];
```

Add the Anthropic option to the bottom of the list:

```ts
return [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "anthropic", label: "Anthropic" },
];
```

Do NOT add to the `image` or `video` returns (Anthropic doesn't generate those).

- [ ] **Step 3: Type-check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/provider-form.tsx
git commit -m "feat(ui): add Anthropic option to text provider dropdown"
```

---

## Task 7: Add maxOutputTokens to the shot_split generateText call

**Files:**
- Modify: `src/app/api/projects/[id]/generate/route.ts` (one line in the `generateText` call inside the chunk processing)

- [ ] **Step 1: Locate the call**

Search the file for the `generateText({` invocation that's inside the `Promise.all` → `sceneChunks.map(async (chunk, idx) => { ... })` block (around line 1304 in current HEAD). It currently reads:

```ts
const result = await Promise.race([
  generateText({
    model,
    system: systemPrompt,
    prompt,
    providerOptions: jsonMode,
    abortSignal: abortController.signal,
  }),
  timeoutPromise,
]);
```

- [ ] **Step 2: Add `maxOutputTokens: 8192`**

Insert the new line right after `abortSignal: abortController.signal,` (keep alphabetized inside the options object — `m` comes after `a`, so this placement is correct):

```ts
const result = await Promise.race([
  generateText({
    model,
    system: systemPrompt,
    prompt,
    providerOptions: jsonMode,
    abortSignal: abortController.signal,
    maxOutputTokens: 8192,
  }),
  timeoutPromise,
]);
```

- [ ] **Step 3: Type-check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/projects/[id]/generate/route.ts
git commit -m "feat(generate): set maxOutputTokens for shot_split (Anthropic compat)"
```

---

## Task 8: Manual smoke test

No code changes — this is a verification task. The dev server should already be running on port 3000 (background task). If not, start it:

```bash
pnpm dev
```

- [ ] **Step 1: Verify the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

Expected: `307` (locale redirect) or `200`.

- [ ] **Step 2: Verify the Protocol type now includes "anthropic"**

The Settings page renders protocol buttons via the type. The cleanest verification: hit the Settings page in a browser, click "Add Provider", pick "Text" capability, and confirm "Anthropic" appears as a button alongside "OpenAI" and "Gemini". If you can't reach the browser, do:

```bash
# Check the type system itself by looking for "anthropic" in the
# dropdown labels (these are static in source, no runtime introspection).
grep -n "Anthropic" src/components/settings/provider-form.tsx
```

Expected: at least one match in the dropdown options.

- [ ] **Step 3: (Optional) Trigger a full end-to-end with a real Anthropic key**

If you have a real Anthropic API key, you can exercise the full flow:
1. Open the app in a browser
2. Settings → Providers → Add Text Provider → "Anthropic"
3. Fill in `https://api.anthropic.com` + your API key
4. Click "获取模型" — should list Claude models
5. Check one → save
6. In a project's episode storyboard, set the text model to the Anthropic one
7. Click "生成分镜" — should complete in 5-15s (vs the M3 60-180s), with `maxOutputTokens: 8192` honored

If you don't have a key to test with, end the smoke test here.

- [ ] **Step 4: Commit (no-op — no code changed)**

```bash
git status
```

Expected: clean working tree. (If you ran `pnpm install` and it touched anything besides `pnpm-lock.yaml`, commit that too.)

---

## Self-Review

**1. Spec coverage** — every requirement in the spec is implemented by a task:

| Spec section | Implemented in |
|---|---|
| §1 package dependency | Task 1 |
| §2 Protocol type extension | Task 2 |
| §3 createLanguageModel case | Task 3 |
| §4 dynamic model list endpoint | Tasks 4 + 5 (extract + wire) |
| §5 Settings UI (base URL + dropdown) | Task 6 |
| §6 maxOutputTokens for shot_split | Task 7 |
| §data-flow section | Covered by the chain Tasks 1→6+7→8 |
| §error-handling section | Inherited from existing patterns (route's catch, fetcher's `if (!res.ok)` throw) |
| §testing section | Tasks 4 (unit) + 8 (manual) |

**2. Placeholder scan** — searched the plan for: TBD, TODO, "implement later", "fill in", "appropriate", "similar to", "handle edge cases", bare references. None found. Every code step shows the actual code; every command shows the expected output.

**3. Type consistency** — types, functions, and property names used across tasks:
- `fetchAnthropicModels(baseUrl, apiKey)` is defined in Task 4 and used in Task 5 — same signature
- `ModelItem { id, name }` interface — defined in Task 4, used in Task 5
- `Protocol` union extended with `"anthropic"` in Task 2, then referenced as a `Protocol` value in Tasks 3 and 6
- `maxOutputTokens: 8192` literal in Task 7 — no naming to track
- `createAnthropic({ apiKey, baseURL })` — Task 3's import + usage matches the same constructor signature in Task 4's tests (we don't construct it in tests; we only import `createAnthropic` for the TS check). No drift.

**4. Plan size** — 8 tasks, 7 with code changes, 1 with verification. The spec covered one feature surface (Anthropic text provider) cleanly without decomposition needs.
