# ComfyUI Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ComfyUI as a first-class Provider protocol for both image and video generation, with user-uploaded workflows stored in the database and placeholder-based prompt injection.

**Architecture:** ComfyUI is treated like any other Provider: two new provider classes implement the existing `AIProvider` and `VideoProvider` interfaces, a shared client handles ComfyUI HTTP calls and workflow substitution, and the settings UI lists ComfyUI first in the image/video protocol options.

**Tech Stack:** TypeScript, Next.js, Drizzle ORM, SQLite, Zustand.

## Global Constraints

- Do not break existing API Provider behavior.
- ComfyUI Provider must implement existing `AIProvider` / `VideoProvider` interfaces.
- Workflow JSON is stored as a string in SQLite; output node is auto-detected but user-overridable.
- Placeholders use `{{name}}` syntax.
- A workflow is tied to exactly one capability: `"image"` or `"video"`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/db/schema.ts` | Add `comfyWorkflows` table. |
| `drizzle/0020_add_comfy_workflows.sql` | Migration creating the table. |
| `src/lib/ai/providers/comfyui-client.ts` | Shared ComfyUI HTTP client: `/prompt`, `/history`, `/view`, `/upload/image`, polling. |
| `src/lib/ai/providers/comfyui-workflows.ts` | Placeholder substitution, output-node detection, image upload preparation. |
| `src/lib/ai/providers/comfyui-image.ts` | `AIProvider` implementation delegating image generation to ComfyUI. |
| `src/lib/ai/providers/comfyui-video.ts` | `VideoProvider` implementation delegating video generation to ComfyUI. |
| `src/lib/ai/provider-factory.ts` | Add `"comfyui"` branches to `createAIProvider` and `createVideoProvider`. |
| `src/stores/model-store.ts` | Add `"comfyui"` to `Protocol` union. |
| `src/components/settings/provider-form.tsx` | Put ComfyUI first in image/video protocol lists; show workflow selector. |
| `src/app/api/projects/[id]/comfy-workflows/route.ts` | CRUD API for project/global ComfyUI workflows. |
| `src/components/settings/comfy-workflow-manager.tsx` | UI for uploading, listing, and deleting workflows. |
| `src/lib/ai/ai-sdk.test.ts` | Tests for workflow substitution and output-node detection. |

---

### Task 1: Database Schema and Migration

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0020_add_comfy_workflows.sql`
- Test: `npx drizzle-kit push` (verify table exists)

**Interfaces:**
- Consumes: existing `projects` table.
- Produces: `comfyWorkflows` Drizzle table export.

- [ ] **Step 1: Add `comfyWorkflows` table to schema**

Add near the other table definitions in `src/lib/db/schema.ts`:

```typescript
export const comfyWorkflows = sqliteTable("comfy_workflows", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  capability: text("capability", { enum: ["image", "video"] }).notNull(),
  workflowJson: text("workflow_json").notNull(),
  outputNodeId: text("output_node_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
```

- [ ] **Step 2: Generate migration**

Run:

```bash
npx drizzle-kit generate --name add_comfy_workflows
```

Expected: a new SQL file appears in `drizzle/` with `CREATE TABLE "comfy_workflows"`.

- [ ] **Step 3: Apply migration**

Run:

```bash
npx drizzle-kit push
```

Expected: migration applies successfully.

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/schema.ts drizzle/
git commit -m "feat(db): add comfy_workflows table"
```

---

### Task 2: ComfyUI Shared Client and Workflow Utilities

**Files:**
- Create: `src/lib/ai/providers/comfyui-client.ts`
- Create: `src/lib/ai/providers/comfyui-workflows.ts`
- Test: `src/lib/ai/ai-sdk.test.ts`

**Interfaces:**
- Consumes: nothing yet.
- Produces:
  - `detectOutputNodeId(workflow: unknown): string | null`
  - `substitutePlaceholders(workflow: Record<string, unknown>, values: Record<string, string>): Record<string, unknown>`
  - `class ComfyUIClient` with methods:
    - `constructor(baseUrl: string)`
    - `uploadImage(filePath: string): Promise<string>` returns uploaded filename
    - `enqueue(workflow: Record<string, unknown>): Promise<string>` returns promptId
    - `waitForOutput(promptId: string, outputNodeId: string, timeoutMs?: number): Promise<string[]>` returns output filenames
    - `download(filename: string, outputPath: string): Promise<void>`

- [ ] **Step 1: Write failing tests for workflow utilities**

Add to `src/lib/ai/ai-sdk.test.ts` (import the new functions at the top):

```typescript
import {
  detectOutputNodeId,
  substitutePlaceholders,
} from "./providers/comfyui-workflows.ts";

test("detectOutputNodeId: finds SaveImage node", () => {
  const workflow = {
    "1": { class_type: "KSampler", inputs: {} },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "out" } },
  };
  assert.equal(detectOutputNodeId(workflow), "9");
});

test("detectOutputNodeId: returns null when no output node", () => {
  const workflow = {
    "1": { class_type: "KSampler", inputs: {} },
  };
  assert.equal(detectOutputNodeId(workflow), null);
});

test("substitutePlaceholders: replaces prompt placeholder", () => {
  const workflow = {
    "6": { inputs: { text: "{{prompt}}" }, class_type: "CLIPTextEncode" },
  };
  const result = substitutePlaceholders(workflow, { prompt: "a cat" });
  assert.equal((result["6"] as { inputs: { text: string } }).inputs.text, "a cat");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts
```

Expected: failures because functions do not exist.

- [ ] **Step 3: Implement `comfyui-workflows.ts`**

```typescript
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
```

- [ ] **Step 4: Implement `comfyui-client.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

interface QueueResponse {
  prompt_id: string;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string }>; videos?: Array<{ filename: string }> }>;
  status?: { completed?: boolean; status_str?: string };
}

export class ComfyUIClient {
  constructor(private baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async uploadImage(filePath: string): Promise<string> {
    const form = new FormData();
    const blob = new Blob([fs.readFileSync(filePath)]);
    form.append("image", blob, path.basename(filePath));
    const res = await fetch(this.url("/upload/image"), { method: "POST", body: form });
    if (!res.ok) throw new Error(`ComfyUI upload failed: ${await res.text()}`);
    const data = (await res.json()) as { name: string };
    return data.name;
  }

  async enqueue(workflow: Record<string, unknown>): Promise<string> {
    const res = await fetch(this.url("/prompt"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      const res = await fetch(this.url(`/history/${promptId}`));
      if (!res.ok) throw new Error(`ComfyUI history fetch failed: ${await res.text()}`);
      const data = (await res.json()) as Record<string, HistoryEntry>;
      const entry = data[promptId];
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
    const res = await fetch(this.url(`/view?filename=${encodeURIComponent(filename)}`));
    if (!res.ok) throw new Error(`ComfyUI download failed for ${filename}`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
  }
}
```

- [ ] **Step 5: Run tests**

```bash
node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts
```

Expected: the three new tests pass; existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/providers/comfyui-client.ts src/lib/ai/providers/comfyui-workflows.ts src/lib/ai/ai-sdk.test.ts
git commit -m "feat(comfyui): add shared client and workflow utilities"
```

---

### Task 3: ComfyUI Image Provider

**Files:**
- Create: `src/lib/ai/providers/comfyui-image.ts`
- Modify: `src/lib/ai/provider-factory.ts`

**Interfaces:**
- Consumes: `ComfyUIClient`, `substitutePlaceholders`, `detectOutputNodeId`, `db` + `comfyWorkflows`.
- Produces: `ComfyUIImageProvider` class implementing `AIProvider`.

- [ ] **Step 1: Implement `ComfyUIImageProvider`**

```typescript
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

    const [width, height] = parseRatio(options?.ratio ?? "16:9");
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
```

- [ ] **Step 2: Wire into `provider-factory.ts`**

Add import:

```typescript
import { ComfyUIImageProvider } from "./providers/comfyui-image";
```

Add case in `createAIProvider`:

```typescript
case "comfyui":
  if (!config.workflowId) throw new Error("ComfyUI provider requires a workflowId");
  return new ComfyUIImageProvider({
    baseUrl: config.baseUrl,
    workflowId: config.workflowId,
    uploadDir: uploadDir ?? process.env.UPLOAD_DIR ?? "./uploads",
  });
```

- [ ] **Step 3: Temporarily skip runtime verification and run TypeScript check**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/providers/comfyui-image.ts src/lib/ai/provider-factory.ts
git commit -m "feat(comfyui): add image provider"
```

---

### Task 4: ComfyUI Video Provider

**Files:**
- Create: `src/lib/ai/providers/comfyui-video.ts`
- Modify: `src/lib/ai/provider-factory.ts`

**Interfaces:**
- Consumes: `ComfyUIClient`, `substitutePlaceholders`, `detectOutputNodeId`, `db` + `comfyWorkflows`.
- Produces: `ComfyUIVideoProvider` class implementing `VideoProvider`.

- [ ] **Step 1: Implement `ComfyUIVideoProvider`**

```typescript
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
```

- [ ] **Step 2: Wire into `provider-factory.ts`**

Add import:

```typescript
import { ComfyUIVideoProvider } from "./providers/comfyui-video";
```

Add case in `createVideoProvider`:

```typescript
case "comfyui":
  if (!config.workflowId) throw new Error("ComfyUI provider requires a workflowId");
  return new ComfyUIVideoProvider({
    baseUrl: config.baseUrl,
    workflowId: config.workflowId,
    uploadDir: uploadDir ?? process.env.UPLOAD_DIR ?? "./uploads",
  });
```

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/providers/comfyui-video.ts src/lib/ai/provider-factory.ts
git commit -m "feat(comfyui): add video provider"
```

---

### Task 5: Model Store Protocol Update

**Files:**
- Modify: `src/stores/model-store.ts`
- Modify: `src/lib/ai/provider-factory.ts` (ProviderConfig interface)

**Interfaces:**
- Consumes: nothing.
- Produces: `Protocol` includes `"comfyui"`; `ProviderConfig` includes optional `workflowId`.

- [ ] **Step 1: Add `"comfyui"` to `Protocol`**

Change line 5 of `src/stores/model-store.ts`:

```typescript
export type Protocol = "comfyui" | "openai" | "gemini" | "seedance" | "ucloud-seedance" | "kling" | "wan" | "dashscope" | "minimax" | "anthropic" | "ark";
```

- [ ] **Step 2: Add `workflowId` to provider config types**

Modify `src/lib/ai/provider-factory.ts`:

```typescript
interface ProviderConfig {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  secretKey?: string;
  modelId: string;
  workflowId?: string;
}
```

Modify `src/stores/model-store.ts`:

```typescript
export interface ModelConfig {
  text: { protocol: Protocol; baseUrl: string; apiKey: string; secretKey?: string; modelId: string; workflowId?: string } | null;
  image: { protocol: Protocol; baseUrl: string; apiKey: string; secretKey?: string; modelId: string; workflowId?: string } | null;
  video: { protocol: Protocol; baseUrl: string; apiKey: string; secretKey?: string; modelId: string; workflowId?: string } | null;
}
```

And update `getModelConfig` `resolve` function to include `workflowId`:

```typescript
return {
  protocol: provider.protocol,
  baseUrl: provider.baseUrl,
  apiKey: provider.apiKey,
  secretKey: provider.secretKey,
  modelId: ref.modelId,
  workflowId: provider.workflowId,
};
```

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/stores/model-store.ts src/lib/ai/provider-factory.ts
git commit -m "feat(comfyui): add protocol and workflowId to config types"
```

---

### Task 6: Settings UI — ComfyUI First in Lists and Workflow Selector

**Files:**
- Modify: `src/components/settings/provider-form.tsx`

**Interfaces:**
- Consumes: `Protocol`, `Provider` type with `workflowId`.
- Produces: UI where ComfyUI is the first image/video protocol option and selecting it shows workflow selector.

- [ ] **Step 1: Add ComfyUI to protocol options and put it first**

Change `DEFAULT_BASE_URLS`:

```typescript
const DEFAULT_BASE_URLS: Record<Protocol, string> = {
  comfyui: "http://127.0.0.1:8188",
  openai: "https://api.openai.com",
  // ... rest unchanged
};
```

Change `getProtocolOptions`:

```typescript
if (capability === "image") {
  return [
    { value: "comfyui", label: "ComfyUI" },
    { value: "openai", label: "OpenAI" },
    { value: "gemini", label: "Gemini" },
    { value: "kling", label: "Kling" },
    { value: "dashscope", label: "百炼 (图片)" },
    { value: "minimax", label: "MiniMax" },
    { value: "ark", label: "火山引擎" },
  ];
}
return [
  { value: "comfyui", label: "ComfyUI" },
  { value: "seedance", label: "Seedance" },
  { value: "ucloud-seedance", label: "Seedance (UCloud)" },
  { value: "gemini", label: "Gemini (Veo)" },
  { value: "kling", label: "Kling" },
  { value: "wan", label: "百炼 (视频)" },
  { value: "minimax", label: "MiniMax" },
];
```

- [ ] **Step 2: Add workflow selector for comfyui protocol**

In `ProviderForm`, add state for workflows:

```typescript
const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; capability: string }>>([]);

useEffect(() => {
  if (provider.protocol !== "comfyui") return;
  fetch(`/api/projects/${projectId}/comfy-workflows?capability=${provider.capability}`)
    .then((r) => r.json())
    .then((data) => setWorkflows(data.workflows ?? []))
    .catch(() => setWorkflows([]));
}, [provider.protocol, provider.capability, projectId]);
```

Render selector below baseUrl input when `provider.protocol === "comfyui"`:

```tsx
{provider.protocol === "comfyui" && (
  <div className="space-y-1.5">
    <Label className="text-xs">ComfyUI Workflow</Label>
    <select
      value={provider.workflowId ?? ""}
      onChange={(e) => updateProvider(provider.id, { workflowId: e.target.value || undefined })}
      className="w-full rounded-lg border border-[--border-subtle] bg-transparent px-2.5 py-[7px] text-xs"
    >
      <option value="">Select a workflow</option>
      {workflows.map((w) => (
        <option key={w.id} value={w.id}>{w.name}</option>
      ))}
    </select>
  </div>
)}
```

- [ ] **Step 3: Run TypeScript and lint checks**

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/settings/provider-form.tsx
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/provider-form.tsx
git commit -m "feat(ui): list ComfyUI first and add workflow selector"
```

---

### Task 7: Workflow Management API

**Files:**
- Create: `src/app/api/projects/[id]/comfy-workflows/route.ts`

**Interfaces:**
- Consumes: `comfyWorkflows` table.
- Produces: REST endpoints `GET`, `POST`, `DELETE`.

- [ ] **Step 1: Implement API route**

```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { comfyWorkflows } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { detectOutputNodeId } from "@/lib/ai/providers/comfyui-workflows";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const { searchParams } = new URL(request.url);
  const capability = searchParams.get("capability") as "image" | "video" | null;
  const conds = [and(eq(comfyWorkflows.projectId, projectId), isNull(comfyWorkflows.projectId))];
  // Actually: projectId = X OR projectId IS NULL
  const rows = await db
    .select()
    .from(comfyWorkflows)
    .where(
      capability
        ? and(
            eq(comfyWorkflows.capability, capability),
            or(eq(comfyWorkflows.projectId, projectId), isNull(comfyWorkflows.projectId)),
          )
        : or(eq(comfyWorkflows.projectId, projectId), isNull(comfyWorkflows.projectId)),
    );
  return NextResponse.json({ workflows: rows });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const body = (await request.json()) as {
    name: string;
    capability: "image" | "video";
    workflowJson: string;
    projectId?: string | null;
    outputNodeId?: string;
  };
  const workflow = JSON.parse(body.workflowJson) as Record<string, unknown>;
  const outputNodeId = body.outputNodeId ?? detectOutputNodeId(workflow);
  const id = genId();
  await db.insert(comfyWorkflows).values({
    id,
    projectId: body.projectId === undefined ? projectId : (body.projectId ?? null),
    name: body.name,
    capability: body.capability,
    workflowJson: body.workflowJson,
    outputNodeId,
  });
  return NextResponse.json({ id });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const { searchParams } = new URL(request.url);
  const workflowId = searchParams.get("workflowId");
  if (!workflowId) return NextResponse.json({ error: "workflowId required" }, { status: 400 });
  await db.delete(comfyWorkflows).where(eq(comfyWorkflows.id, workflowId));
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Fix import for `or`**

Add `or` to the `drizzle-orm` import:

```typescript
import { eq, and, isNull, or } from "drizzle-orm";
```

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/projects/[id]/comfy-workflows/route.ts
git commit -m "feat(api): add ComfyUI workflow CRUD endpoints"
```

---

### Task 8: Workflow Management UI

**Files:**
- Create: `src/components/settings/comfy-workflow-manager.tsx`

**Interfaces:**
- Consumes: workflow API endpoints.
- Produces: reusable component for uploading/listing/deleting workflows.

- [ ] **Step 1: Implement component**

```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2, Upload } from "lucide-react";

type Capability = "image" | "video";

interface Workflow {
  id: string;
  name: string;
  capability: Capability;
  outputNodeId: string | null;
}

interface ComfyWorkflowManagerProps {
  projectId: string;
  capability?: Capability;
}

export function ComfyWorkflowManager({ projectId, capability }: ComfyWorkflowManagerProps) {
  const t = useTranslations();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [name, setName] = useState("");
  const [cap, setCap] = useState<Capability>(capability ?? "image");
  const [json, setJson] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const url = capability
      ? `/api/projects/${projectId}/comfy-workflows?capability=${capability}`
      : `/api/projects/${projectId}/comfy-workflows`;
    const res = await fetch(url);
    const data = (await res.json()) as { workflows: Workflow[] };
    setWorkflows(data.workflows ?? []);
  }, [projectId, capability]);

  useEffect(() => { load(); }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !json.trim()) return;
    setLoading(true);
    try {
      await fetch(`/api/projects/${projectId}/comfy-workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, capability: cap, workflowJson: json }),
      });
      setName("");
      setJson("");
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    await fetch(`/api/projects/${projectId}/comfy-workflows?workflowId=${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-[--border-subtle] p-4">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("common.name")}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Image Workflow" />
        </div>
        {!capability && (
          <div className="space-y-1.5">
            <Label className="text-xs">Capability</Label>
            <select
              value={cap}
              onChange={(e) => setCap(e.target.value as Capability)}
              className="w-full rounded-lg border border-[--border-subtle] bg-transparent px-2.5 py-[7px] text-xs"
            >
              <option value="image">Image</option>
              <option value="video">Video</option>
            </select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-xs">Workflow JSON</Label>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={8}
            placeholder='Paste ComfyUI workflow JSON here...'
            className="w-full rounded-lg border border-[--border-subtle] bg-transparent px-2.5 py-2 text-xs"
          />
        </div>
        <Button type="submit" size="sm" disabled={loading}>
          {loading ? "..." : <><Upload className="mr-1 h-3 w-3" /> Upload</>}
        </Button>
      </form>

      <div className="space-y-2">
        {workflows.map((w) => (
          <div key={w.id} className="flex items-center justify-between rounded-lg border border-[--border-subtle] px-3 py-2">
            <div>
              <div className="text-sm font-medium">{w.name}</div>
              <div className="text-[10px] text-[--text-muted]">{w.capability} {w.outputNodeId ? `• output: ${w.outputNodeId}` : ""}</div>
            </div>
            <button onClick={() => handleDelete(w.id)} className="rounded p-1 hover:bg-red-50 hover:text-red-500">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Expose manager in settings page**

The component should be rendered on the project settings page. Find the settings route (e.g., `src/app/[locale]/project/[id]/settings/page.tsx`) and add:

```tsx
<ComfyWorkflowManager projectId={projectId} />
```

- [ ] **Step 3: Run TypeScript and lint**

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/settings/comfy-workflow-manager.tsx
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/comfy-workflow-manager.tsx src/app/[locale]/project/[id]/settings/page.tsx
git commit -m "feat(ui): add ComfyUI workflow manager"
```

---

### Task 9: Final Integration Verification

**Files:**
- All of the above.

- [ ] **Step 1: Run full TypeScript check**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 2: Run tests**

```bash
node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run lint on touched files**

```bash
npx eslint src/lib/ai/providers/comfyui-client.ts src/lib/ai/providers/comfyui-workflows.ts src/lib/ai/providers/comfyui-image.ts src/lib/ai/providers/comfyui-video.ts src/lib/ai/provider-factory.ts src/stores/model-store.ts src/components/settings/provider-form.tsx src/components/settings/comfy-workflow-manager.tsx src/app/api/projects/[id]/comfy-workflows/route.ts
```

Expected: no errors.

- [ ] **Step 4: Manual smoke test checklist**

1. Start ComfyUI locally on `http://127.0.0.1:8188`.
2. Open project settings → ComfyUI workflow manager.
3. Upload an image workflow JSON containing `{{prompt}}` and a `SaveImage` node.
4. Add an image Provider, select protocol `ComfyUI`, pick the uploaded workflow.
5. Go to storyboard, generate a single first frame.
6. Expected: request goes to local ComfyUI, image is generated and saved.
7. Repeat with a video workflow containing `{{prompt}}`, `{{first_frame}}`, `{{last_frame}}`.

- [ ] **Step 5: Commit any final fixes and push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**
- ComfyUI as Provider protocol: Tasks 3, 4, 5.
- UI list first: Task 6 Step 1.
- User-uploaded workflows in DB: Task 1.
- Placeholder substitution: Task 2 Step 3 and used in Tasks 3, 4.
- Output node detection: Task 2 Step 3.
- Image/video support: Tasks 3, 4.
- Workflow management UI/API: Tasks 7, 8.
- Error handling: included in `ComfyUIClient` and provider implementations.

**Placeholder scan:** No TBD/TODO/fill-in-details found. All code blocks contain concrete implementation.

**Type consistency:** `ProviderConfig` gains `workflowId`; `ModelConfig` and `getModelConfig` pass it through; both provider constructors consume `workflowId`. `Protocol` includes `"comfyui"` consistently.
