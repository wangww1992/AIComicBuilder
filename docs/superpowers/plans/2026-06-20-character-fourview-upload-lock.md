# 角色四视图本地上传 + 锁定保护 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `characters` 表加 `is_locked` 列，让用户上传的四视图不再被 AI 重生覆盖；同时让单角色重生时把已有 `referenceImage` 当 image-to-image reference 喂回去。

**Architecture:** 单列布尔字段 + 上传路由自动锁定 + 两个 generate handler 加 early-return / batch skip。前端在 CharacterCard 加锁徽章 + 解锁按钮，inline panel 加角标，列表页 toast 报告 skipped_locked 数。下游分镜首帧不动。

**Tech Stack:** Next.js App Router、drizzle-orm（better-sqlite3）、React 19、Tailwind、next-intl、lucide-react、sonner。测试用 Node 22 内置 `node:test`（参考 `src/lib/ai/ai-sdk.test.ts`，运行：`node --experimental-strip-types --test <path>`）。

## Global Constraints

- 数据库：SQLite via `better-sqlite3`；迁移在应用启动时自动跑（`src/lib/bootstrap.ts:13`）。新迁移文件必须放在 `drizzle/` 下，文件名前缀连号（当前最大 `0053_*`）。
- 列默认值必须可为空或带 `DEFAULT` —— 旧行无值不能违反 `NOT NULL`。
- TS 严格模式：所有新增字段在 schema、API 类型、前端 Props 中保持一致命名 `isLocked`（驼峰）+ `is_locked`（DB 列）。
- 国际化：每个新文案必须同步在 `messages/zh.json` 和 `messages/en.json`，挂在 `character.*`。
- 不修改 prompt 模板 (`character_image` registry / `character-image.ts`)。
- 不动下游分镜首帧逻辑 (`generate/route.ts:1789`)。
- 测试用 `node:test` + `node --experimental-strip-types`（不引入 jest/vitest）。

---

### Task 1: Schema 列 + Migration

**Files:**
- Modify: `src/lib/db/schema.ts:63-81` (characters 表)
- Create: `drizzle/0054_add_character_is_locked.sql`

**Interfaces:**
- Produces:
  - `characters.isLocked: number`（drizzle 推断），DB 列 `is_locked INTEGER NOT NULL DEFAULT 0`，值域 `0 | 1`。

- [ ] **Step 1: 在 characters 表的 schema 中加 `isLocked`**

修改 `src/lib/db/schema.ts:77` 后面（紧邻 `isStale` 那一行下方）插入：

```ts
  isStale: integer("is_stale").notNull().default(0),
  isLocked: integer("is_locked").notNull().default(0),
  episodeId: text("episode_id").references(() => episodes.id, {
```

- [ ] **Step 2: 创建 migration 文件**

新建 `drizzle/0054_add_character_is_locked.sql`，内容：

```sql
ALTER TABLE characters ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: 更新 drizzle journal**

打开 `drizzle/meta/_journal.json`，找到 `entries` 数组末尾。复制最后一项的 `when` 时间戳 +1000 ms 作为新 `when`，追加：

```json
    {
      "idx": 54,
      "version": "6",
      "when": <last_when_plus_1000>,
      "tag": "0054_add_character_is_locked",
      "breakpoints": true
    }
```

注意：`idx` 是当前最大 idx +1（如果当前最大是 53 就是 54）；`version` 沿用同代码层最近一项；`tag` 必须与文件名（去 `.sql`）一致。

- [ ] **Step 4: 启动一次 dev 验证迁移成功**

```bash
cd /home/wang/codes/AIComicBuilder
rm -f data/test-migrate.db
DATABASE_URL=file:./data/test-migrate.db npm run dev > /tmp/migrate.log 2>&1 &
SERVER_PID=$!
sleep 6
kill $SERVER_PID 2>/dev/null
sqlite3 data/test-migrate.db "PRAGMA table_info(characters);" | grep is_locked
```

Expected: 一行包含 `is_locked|INTEGER|1|0|0` 的输出（`NOT NULL`, default 0）。

如果失败：`/tmp/migrate.log` 顶部能看到 drizzle migrate 报错。

清理：`rm -f data/test-migrate.db`。

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts drizzle/0054_add_character_is_locked.sql drizzle/meta/_journal.json
git commit -m "feat(db): add characters.is_locked column"
```

---

### Task 2: 上传路由：写库时 set isLocked = 1

**Files:**
- Modify: `src/app/api/projects/[id]/characters/[characterId]/upload/route.ts:55-59`

**Interfaces:**
- Consumes: Task 1 的 `characters.isLocked` 列。
- Produces: 上传成功后返回的 character 对象 `isLocked === 1`。

- [ ] **Step 1: 修改 update 调用**

把 `route.ts:55-59` 的：

```ts
  const [updated] = await db
    .update(characters)
    .set({ referenceImage: filepath, referenceImageHistory: JSON.stringify(history) })
    .where(eq(characters.id, characterId))
    .returning();
```

改成：

```ts
  const [updated] = await db
    .update(characters)
    .set({
      referenceImage: filepath,
      referenceImageHistory: JSON.stringify(history),
      isLocked: 1,
    })
    .where(eq(characters.id, characterId))
    .returning();
```

- [ ] **Step 2: 用 curl 验证**

启动 dev：`npm run dev` 后台跑。然后挑一个已有 character ID（去某个项目页 URL bar 看），跑：

```bash
echo "test" > /tmp/fake.png
curl -s -X POST http://localhost:3000/api/projects/<PID>/characters/<CID>/upload \
  -F "file=@/tmp/fake.png" -H "Cookie: <browser cookie>" | jq '.isLocked'
```

Expected: `1`。

- [ ] **Step 3: Commit**

```bash
git add src/app/api/projects/[id]/characters/[characterId]/upload/route.ts
git commit -m "feat(api): lock character on manual reference image upload"
```

---

### Task 3: PATCH 路由：白名单加 isLocked

**Files:**
- Modify: `src/app/api/projects/[id]/characters/[characterId]/route.ts:25-39`

**Interfaces:**
- Consumes: Task 1 的列。
- Produces: `PATCH /characters/[cid]` 接受 `{ isLocked: 0 | 1 }` 字段。

- [ ] **Step 1: 在 body 类型中加 isLocked**

把 `route.ts:25-32` 的：

```ts
  const body = (await request.json()) as Partial<{
    name: string;
    description: string;
    visualHint: string;
    scope: string;
    episodeId: string | null;
    referenceImage: string;
  }>;
```

改成：

```ts
  const body = (await request.json()) as Partial<{
    name: string;
    description: string;
    visualHint: string;
    scope: string;
    episodeId: string | null;
    referenceImage: string;
    isLocked: 0 | 1;
  }>;
```

- [ ] **Step 2: 在 updateData 拼装中加分支**

紧接 `route.ts:39` 那一行（`if (body.referenceImage !== undefined) updateData.referenceImage = body.referenceImage;`）下方插入：

```ts
  if (body.isLocked !== undefined) {
    // Coerce to 0 | 1 only — reject anything else
    updateData.isLocked = body.isLocked === 1 ? 1 : 0;
  }
```

- [ ] **Step 3: 用 curl 验证 PATCH 解锁可走通**

继续上一任务的 dev 进程，跑：

```bash
curl -s -X PATCH http://localhost:3000/api/projects/<PID>/characters/<CID> \
  -H "Content-Type: application/json" -H "Cookie: <cookie>" \
  -d '{"isLocked":0}' | jq '.isLocked'
```

Expected: `0`。

- [ ] **Step 4: Commit**

```bash
git add src/app/api/projects/[id]/characters/[characterId]/route.ts
git commit -m "feat(api): allow toggling character isLocked via PATCH"
```

---

### Task 4: 重构 generate handler — 抽出可测试的纯函数（仅为可测）

**Files:**
- Modify: `src/app/api/projects/[id]/generate/route.ts:916-995` (handleSingleCharacterImage), `:997-1060` (handleBatchCharacterImage)
- Create: `src/lib/ai/character-image-options.ts`
- Create: `src/lib/ai/character-image-options.test.ts`

> 设计决策：handler 直连 db + NextResponse 不易单元测。我们把"决定要不要 reference / 锁定时返哪个 status"的纯逻辑抽成 `buildCharacterImageOptions` 与 `classifyLocked`，handler 改成调用这俩函数 + 处理 IO。这样 §8.1 单元测试可以聚焦纯逻辑、不 mock provider。

**Interfaces:**
- Produces:
  ```ts
  // src/lib/ai/character-image-options.ts
  export interface CharacterRefInput {
    referenceImage: string | null;
    name: string;
  }
  /** Build the partial ImageOptions enabling image-to-image when char has an image. */
  export function buildCharacterImageOptions(
    char: CharacterRefInput
  ): { referenceImages?: string[]; referenceLabels?: string[] };
  ```

- [ ] **Step 1: 写失败的测试**

Create `src/lib/ai/character-image-options.test.ts`:

```ts
// @ts-nocheck — Node 22 --experimental-strip-types convention; see ai-sdk.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCharacterImageOptions } from "./character-image-options.ts";

test("no referenceImage → empty object (pure t2i)", () => {
  const out = buildCharacterImageOptions({ referenceImage: null, name: "Alice" });
  assert.deepEqual(out, {});
});

test("with referenceImage → passes path + label as singletons", () => {
  const out = buildCharacterImageOptions({
    referenceImage: "./uploads/characters/abc.png",
    name: "Alice",
  });
  assert.deepEqual(out, {
    referenceImages: ["./uploads/characters/abc.png"],
    referenceLabels: ["Alice"],
  });
});

test("empty string referenceImage is treated as none", () => {
  const out = buildCharacterImageOptions({ referenceImage: "", name: "Alice" });
  assert.deepEqual(out, {});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --experimental-strip-types --test src/lib/ai/character-image-options.test.ts
```

Expected: FAIL with `Cannot find module './character-image-options.ts'` or similar.

- [ ] **Step 3: 写最小实现**

Create `src/lib/ai/character-image-options.ts`:

```ts
/**
 * Pure helpers for character turnaround generation. Kept separate from the
 * Next.js route handler so they can be unit-tested without spinning up
 * the DB or AI provider stack.
 */

export interface CharacterRefInput {
  referenceImage: string | null;
  name: string;
}

/**
 * If the character already has a reference image, return options enabling
 * image-to-image (i2i) by passing the path + character name to the image
 * provider. Otherwise return `{}` for plain text-to-image.
 *
 * The path is forwarded verbatim — providers (MiniMax, ARK) handle local
 * `./uploads/...` paths by reading and inlining as data URL.
 */
export function buildCharacterImageOptions(
  char: CharacterRefInput
): { referenceImages?: string[]; referenceLabels?: string[] } {
  if (!char.referenceImage) return {};
  return {
    referenceImages: [char.referenceImage],
    referenceLabels: [char.name],
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --experimental-strip-types --test src/lib/ai/character-image-options.test.ts
```

Expected: 所有 3 个 test 都 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/character-image-options.ts src/lib/ai/character-image-options.test.ts
git commit -m "feat(ai): pure helper for character image i2i options"
```

---

### Task 5: 单角色 handler — 锁定 early-return + 用 i2i

**Files:**
- Modify: `src/app/api/projects/[id]/generate/route.ts:916-995` (handleSingleCharacterImage)

**Interfaces:**
- Consumes: Task 1 的列，Task 4 的 `buildCharacterImageOptions`。
- Produces: 锁定时返回 HTTP 409 `{ characterId, status: "skipped_locked", message }`；未锁定时调用 provider 并透传 i2i 选项。

- [ ] **Step 1: 在 generate/route.ts 顶部 import**

在 `src/app/api/projects/[id]/generate/route.ts` 的 import 块（约第 51 行附近 `buildCharacterTurnaroundPrompt` 那行下面）加：

```ts
import { buildCharacterImageOptions } from "@/lib/ai/character-image-options";
```

- [ ] **Step 2: 锁定 early-return**

在 `handleSingleCharacterImage` 中找到这段（约 line 940-941）：

```ts
  const ai = resolveImageProvider(modelConfig);
  const prompt = buildCharacterTurnaroundPrompt(character.description || character.name, character.name);
```

替换为：

```ts
  // Locked characters keep their manual upload — refuse to overwrite.
  // The unlock is a deliberate user action via PATCH { isLocked: 0 }.
  if (character.isLocked) {
    return NextResponse.json(
      {
        characterId,
        status: "skipped_locked",
        message: "Character is locked. Unlock it before regenerating.",
      },
      { status: 409 }
    );
  }

  const ai = resolveImageProvider(modelConfig);
  const prompt = buildCharacterTurnaroundPrompt(character.description || character.name, character.name);
```

- [ ] **Step 3: 透传 i2i 选项**

紧接其后的 `ai.generateImage` 调用（约 line 944-948），把：

```ts
    const imagePath = await ai.generateImage(prompt, {
      size: "2560x1440",
      aspectRatio: "16:9",
      quality: "hd",
    });
```

改为：

```ts
    const imagePath = await ai.generateImage(prompt, {
      size: "2560x1440",
      aspectRatio: "16:9",
      quality: "hd",
      ...buildCharacterImageOptions({
        referenceImage: character.referenceImage,
        name: character.name,
      }),
    });
```

- [ ] **Step 4: 手测 lock 路径**

启动 `npm run dev`。在浏览器里随便挑一个有图的 character，用 DevTools console 直接 PATCH 把它锁了：

```js
fetch(`/api/projects/${PID}/characters/${CID}`, {
  method: "PATCH", headers: {"Content-Type":"application/json"},
  body: JSON.stringify({ isLocked: 1 })
}).then(r => r.json()).then(console.log)
```

然后调 generate：

```js
fetch(`/api/projects/${PID}/generate`, {
  method: "POST", headers: {"Content-Type":"application/json"},
  body: JSON.stringify({
    action: "single_character_image",
    payload: { characterId: CID },
    modelConfig: { image: { protocol: "openai", baseUrl: "x", apiKey: "x", modelId: "x" }},
  })
}).then(async r => ({ status: r.status, body: await r.json() })).then(console.log)
```

Expected: `{ status: 409, body: { characterId, status: "skipped_locked", message: "..." } }`。

注意 modelConfig 字段是占位 —— 因为已经 early-return，不会真的调 provider。

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/[id]/generate/route.ts
git commit -m "feat(api): single character image — lock early-return + i2i feed"
```

---

### Task 6: Batch handler — 锁定跳过 + i2i + 汇总计数

**Files:**
- Modify: `src/app/api/projects/[id]/generate/route.ts:997-1060` (handleBatchCharacterImage)

**Interfaces:**
- Consumes: Task 1 的列，Task 4 的 `buildCharacterImageOptions`。
- Produces: 返回 JSON 形如 `{ results: [...], skippedLocked: number }`，每个被锁角色一个 `{ characterId, name, status: "skipped_locked" }` 项也进 `results`。

- [ ] **Step 1: 改造循环 + 汇总**

在 `handleBatchCharacterImage` 中找到这段（约 line 1024-1059）：

```ts
  const needImages = allCharacters.filter((c) => !c.referenceImage);
  if (needImages.length === 0) {
    return NextResponse.json({ results: [], message: "All characters already have images" });
  }

  const ai = resolveImageProvider(modelConfig);

  const results = await Promise.all(
    needImages.map(async (character) => {
      try {
        const prompt = buildCharacterTurnaroundPrompt(character.description || character.name, character.name);
        const imagePath = await ai.generateImage(prompt, {
          size: "2560x1440",
          aspectRatio: "16:9",
          quality: "hd",
        });

        // Append to history
        let history: string[] = [];
        try { history = JSON.parse(character.referenceImageHistory || "[]"); } catch {}
        if (character.referenceImage && !history.includes(character.referenceImage)) history.push(character.referenceImage);
        if (!history.includes(imagePath)) history.push(imagePath);

        await db
          .update(characters)
          .set({ referenceImage: imagePath, referenceImageHistory: JSON.stringify(history) })
          .where(eq(characters.id, character.id));
        return { characterId: character.id, name: character.name, imagePath, status: "ok" };
      } catch (err) {
        console.error(`[BatchCharacterImage] Error for ${character.name}:`, err);
        return { characterId: character.id, name: character.name, status: "error", error: extractErrorMessage(err) };
      }
    })
  );

  return NextResponse.json({ results });
}
```

替换为：

```ts
  // Eligible: missing image OR has image but unlocked-and-stale (caller's
  // existing `!c.referenceImage` filter is preserved). Locked chars stay
  // in `allCharacters` and surface as skipped entries below — they NEVER
  // hit the provider.
  const lockedSkips = allCharacters
    .filter((c) => c.isLocked)
    .map((c) => ({
      characterId: c.id,
      name: c.name,
      status: "skipped_locked" as const,
    }));

  const needImages = allCharacters.filter((c) => !c.referenceImage && !c.isLocked);
  if (needImages.length === 0) {
    return NextResponse.json({
      results: lockedSkips,
      skippedLocked: lockedSkips.length,
      message: lockedSkips.length > 0
        ? `${lockedSkips.length} character(s) locked, skipped`
        : "All characters already have images",
    });
  }

  const ai = resolveImageProvider(modelConfig);

  const generated = await Promise.all(
    needImages.map(async (character) => {
      try {
        const prompt = buildCharacterTurnaroundPrompt(character.description || character.name, character.name);
        const imagePath = await ai.generateImage(prompt, {
          size: "2560x1440",
          aspectRatio: "16:9",
          quality: "hd",
          ...buildCharacterImageOptions({
            referenceImage: character.referenceImage,
            name: character.name,
          }),
        });

        // Append to history
        let history: string[] = [];
        try { history = JSON.parse(character.referenceImageHistory || "[]"); } catch {}
        if (character.referenceImage && !history.includes(character.referenceImage)) history.push(character.referenceImage);
        if (!history.includes(imagePath)) history.push(imagePath);

        await db
          .update(characters)
          .set({ referenceImage: imagePath, referenceImageHistory: JSON.stringify(history) })
          .where(eq(characters.id, character.id));
        return { characterId: character.id, name: character.name, imagePath, status: "ok" as const };
      } catch (err) {
        console.error(`[BatchCharacterImage] Error for ${character.name}:`, err);
        return { characterId: character.id, name: character.name, status: "error" as const, error: extractErrorMessage(err) };
      }
    })
  );

  return NextResponse.json({
    results: [...generated, ...lockedSkips],
    skippedLocked: lockedSkips.length,
  });
}
```

> 注意：原代码只把 `!c.referenceImage` 的角色喂进 needImages（即只补缺图的）。新代码保留这个语义并加 `&& !c.isLocked`。锁定但有图的角色既不参与生成、也不参与「漏图」检查，只作为 skipped 报告。

- [ ] **Step 2: Commit**

```bash
git add src/app/api/projects/[id]/generate/route.ts
git commit -m "feat(api): batch character image — skip locked + i2i feed"
```

---

### Task 7: 前端类型扩展 + CharacterCard 锁徽章 + 解锁按钮

**Files:**
- Modify: `src/components/editor/character-card.tsx`
- Modify: `src/app/[locale]/project/[id]/characters/page.tsx:12-22` (Character interface)

**Interfaces:**
- Consumes: Task 1 的列（GET `/characters` 自动带回 `isLocked`），Task 3 的 PATCH endpoint。
- Produces: CharacterCard 接受 `isLocked?: number` prop；锁定时禁用「生成」+ 显示锁徽章 + 显示解锁按钮。

- [ ] **Step 1: 列表页 Character interface 加 isLocked**

`src/app/[locale]/project/[id]/characters/page.tsx:12-22` 把：

```ts
interface Character {
  id: string;
  projectId: string;
  name: string;
  description: string;
  visualHint: string | null;
  referenceImage: string | null;
  referenceImageHistory: string | null;
  scope: string;
  episodeId: string | null;
}
```

改成：

```ts
interface Character {
  id: string;
  projectId: string;
  name: string;
  description: string;
  visualHint: string | null;
  referenceImage: string | null;
  referenceImageHistory: string | null;
  scope: string;
  episodeId: string | null;
  isLocked: number;
}
```

- [ ] **Step 2: 列表页两处 `<CharacterCard ... />` 透传 isLocked**

`src/app/[locale]/project/[id]/characters/page.tsx` 第 157-169 行（main 列表）和第 211-225 行（guest 列表）的 `<CharacterCard ... />` 都加上：

```tsx
                isLocked={char.isLocked}
```

放在 `referenceImageHistory={...}` 那行之后即可。

- [ ] **Step 3: CharacterCard props 加 isLocked + lockcon 导入**

`src/components/editor/character-card.tsx:11`：

```ts
import { Sparkles, Loader2, Copy, Check, ArrowUpCircle, Trash2, ChevronLeft, ChevronRight, Upload } from "lucide-react";
```

改成（加 Lock + Unlock）：

```ts
import { Sparkles, Loader2, Copy, Check, ArrowUpCircle, Trash2, ChevronLeft, ChevronRight, Upload, Lock, Unlock } from "lucide-react";
```

`src/components/editor/character-card.tsx:18-32`：

```ts
interface CharacterCardProps {
  id: string;
  projectId: string;
  name: string;
  description: string;
  visualHint: string | null;
  referenceImage: string | null;
  referenceImageHistory?: string | null;
  onUpdate: () => void;
  batchGenerating?: boolean;
  scope?: string;
  onPromote?: () => void;
  onDelete?: () => void;
  episodeName?: string;
}
```

加一行：

```ts
interface CharacterCardProps {
  id: string;
  projectId: string;
  name: string;
  description: string;
  visualHint: string | null;
  referenceImage: string | null;
  referenceImageHistory?: string | null;
  isLocked?: number;
  onUpdate: () => void;
  batchGenerating?: boolean;
  scope?: string;
  onPromote?: () => void;
  onDelete?: () => void;
  episodeName?: string;
}
```

并把 `:34-48` 的解构参数表里加 `isLocked`：

```ts
export function CharacterCard({
  id,
  projectId,
  name,
  description,
  visualHint,
  referenceImage,
  referenceImageHistory,
  isLocked = 0,
  onUpdate,
  batchGenerating,
  scope,
  onPromote,
  onDelete,
  episodeName,
}: CharacterCardProps) {
```

- [ ] **Step 4: 卡片右上加锁徽章 + 解锁 handler**

紧接 `:62` 那行 `const [generating, setGenerating] = useState(false);` 下方加：

```ts
  const [unlocking, setUnlocking] = useState(false);

  async function handleUnlock() {
    if (!confirm(t("character.unlockConfirm"))) return;
    setUnlocking(true);
    try {
      await apiFetch(`/api/projects/${projectId}/characters/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isLocked: 0 }),
      });
      onUpdate();
    } catch (err) {
      console.error("Unlock error:", err);
      toast.error(t("common.unknownError"));
    }
    setUnlocking(false);
  }
```

- [ ] **Step 5: 锁徽章 — 在 referenceImage 渲染分支顶角加**

在 `:147` 的 `{referenceImage ? (() => {` IIFE 内、`return (` 后面那段 JSX 的 `<div className="relative w-full aspect-video ...">` 内，紧接 `</div>` 关闭 lightbox 触发区前（也就是 `:194` 的 `</>` 之后），插入：

```tsx
              {isLocked === 1 && (
                <span
                  className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-full bg-amber-500/95 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
                  title={t("character.lockHint")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Lock className="h-3 w-3" />
                  {t("character.locked")}
                </span>
              )}
```

放在 `{showArrows && (...)}` 块之后、整个 `<div ... onClick={() => setLightbox(true)}>...</div>` 关闭之前。

- [ ] **Step 6: 「生成四视图」按钮加 disabled 条件 + tooltip**

把 `:260-272` 那段 `<Button onClick={handleGenerateImage} ...>`：

```tsx
              <Button
                onClick={handleGenerateImage}
                disabled={isGenerating}
                className="flex-1"
                size="sm"
              >
                {isGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {isGenerating ? t("common.generating") : t("character.generateImage")}
              </Button>
```

改成（disabled 加上 isLocked，title 提示）：

```tsx
              <Button
                onClick={handleGenerateImage}
                disabled={isGenerating || isLocked === 1}
                className="flex-1"
                size="sm"
                title={isLocked === 1 ? t("character.lockHint") : undefined}
              >
                {isGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {isGenerating ? t("common.generating") : t("character.generateImage")}
              </Button>
```

- [ ] **Step 7: 解锁按钮（仅 isLocked === 1 时显示）**

紧接「上传参考图」按钮（`:273-286` 的 `<Button variant="outline" ... title={t("character.uploadImage")} ...>`）之后插入：

```tsx
              {isLocked === 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 px-2.5"
                  title={t("character.unlock")}
                  disabled={unlocking}
                  onClick={handleUnlock}
                >
                  {unlocking ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unlock className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
```

放在 Upload 按钮和 Copy prompt 按钮之间。

- [ ] **Step 8: 验证编译通过**

```bash
cd /home/wang/codes/AIComicBuilder
npx tsc --noEmit 2>&1 | head -20
```

Expected: 无 error 输出（如果有，按报错修文件路径/类型）。

- [ ] **Step 9: Commit**

```bash
git add src/components/editor/character-card.tsx src/app/[locale]/project/[id]/characters/page.tsx
git commit -m "feat(ui): character card lock badge + unlock button"
```

---

### Task 8: CharactersInlinePanel 角标

**Files:**
- Modify: `src/components/editor/characters-inline-panel.tsx:14-18` (Character interface), `:166-170` (status badge)

**Interfaces:**
- Consumes: Task 1 列。
- Produces: 缩略图右上小锁角标（仅视觉，无交互）。

- [ ] **Step 1: 加 isLocked 到 inline panel 的 Character 接口**

`src/components/editor/characters-inline-panel.tsx:14-18`：

```ts
interface Character {
  id: string;
  name: string;
  referenceImage: string | null;
}
```

加一行：

```ts
interface Character {
  id: string;
  name: string;
  referenceImage: string | null;
  isLocked?: number;
}
```

- [ ] **Step 2: import Lock 图标**

`src/components/editor/characters-inline-panel.tsx:11`：

```ts
import { ChevronDown, ChevronUp, Sparkles, Loader2, Users } from "lucide-react";
```

改成：

```ts
import { ChevronDown, ChevronUp, Sparkles, Loader2, Users, Lock } from "lucide-react";
```

- [ ] **Step 3: 缩略图角加锁角标**

在 `:166-170` 的 status badge：

```tsx
                    <div className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${
                      char.referenceImage ? "bg-emerald-500" : "bg-amber-500"
                    }`} />
```

紧跟其后插入：

```tsx
                    {char.isLocked === 1 && (
                      <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white shadow-sm">
                        <Lock className="h-2.5 w-2.5" />
                      </span>
                    )}
```

- [ ] **Step 4: 验证编译**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: 无 error。

> 注：调用方（搜 `CharactersInlinePanel`，应在 storyboard page）目前传 `characters: Character[]`，且现在 GET `/characters` 已经带 `isLocked`；只要调用方原样把 character 对象塞进 panel，`isLocked` 会自然跟着进来。如果调用方用 `.map((c) => ({ id, name, referenceImage }))` 显式只挑了三个字段，要补 `isLocked: c.isLocked`。

- [ ] **Step 5: 检查 inline panel 调用方**

```bash
grep -rn "CharactersInlinePanel" /home/wang/codes/AIComicBuilder/src --include="*.tsx" -A 5 | grep -A 5 "characters="
```

如果输出里调用方有 `.map((c) => ({ id: c.id, name: c.name, referenceImage: c.referenceImage }))` 这种显式字段挑选，把它改成包含 `isLocked: c.isLocked`。如果是直接传完整 character 对象就不用动。

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/characters-inline-panel.tsx
# 如果改了调用方:
# git add <call-site-file>
git commit -m "feat(ui): inline panel lock corner badge"
```

---

### Task 9: 批量按钮 toast 报告 skippedLocked

**Files:**
- Modify: `src/app/[locale]/project/[id]/episodes/[episodeId]/characters/page.tsx:63-90` (handleBatchGenerateImages)

**Interfaces:**
- Consumes: Task 6 的返回 schema `{ results, skippedLocked }`。

- [ ] **Step 1: 改 toast 逻辑**

把 `:63-90`：

```tsx
  async function handleBatchGenerateImages() {
    if (!project) return;
    if (!imageGuard()) return;
    setGeneratingImages(true);

    try {
      const response = await apiFetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batch_character_image",
          modelConfig: getModelConfig(),
          episodeId: useProjectStore.getState().currentEpisodeId,
        }),
      });

      const data = await response.json() as { results: Array<{ status: string }> };
      if (data.results?.some((r) => r.status === "error")) {
        toast.warning(t("common.batchPartialFailed"));
      }
    } catch (err) {
      console.error("Batch character image error:", err);
      toast.error(t("common.generationFailed"));
    }

    setGeneratingImages(false);
    fetchProject(project.id, useProjectStore.getState().currentEpisodeId!);
  }
```

改成：

```tsx
  async function handleBatchGenerateImages() {
    if (!project) return;
    if (!imageGuard()) return;
    setGeneratingImages(true);

    try {
      const response = await apiFetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batch_character_image",
          modelConfig: getModelConfig(),
          episodeId: useProjectStore.getState().currentEpisodeId,
        }),
      });

      const data = await response.json() as {
        results: Array<{ status: string }>;
        skippedLocked?: number;
      };
      if (data.results?.some((r) => r.status === "error")) {
        toast.warning(t("common.batchPartialFailed"));
      }
      if (data.skippedLocked && data.skippedLocked > 0) {
        toast.info(t("character.batchSkippedLocked", { count: data.skippedLocked }));
      }
    } catch (err) {
      console.error("Batch character image error:", err);
      toast.error(t("common.generationFailed"));
    }

    setGeneratingImages(false);
    fetchProject(project.id, useProjectStore.getState().currentEpisodeId!);
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/app/[locale]/project/[id]/episodes/[episodeId]/characters/page.tsx
git commit -m "feat(ui): toast skipped-locked count after batch generation"
```

---

### Task 10: i18n 5 个 key

**Files:**
- Modify: `messages/zh.json:101-129` (character block)
- Modify: `messages/en.json` (character block — same path)

**Interfaces:**
- Consumes: Task 7/8/9 中引用的 5 个 key。

- [ ] **Step 1: 中文 key**

`messages/zh.json:101-129` 的 character block 末尾（`relType_neutral` 那行之前）插入这 5 行（注意保留逗号正确）：

```json
    "locked": "已锁定",
    "lockHint": "手工上传的参考图，自动生成时跳过",
    "unlock": "解锁",
    "unlockConfirm": "解锁后再次生成四视图会覆盖当前图，确定？",
    "batchSkippedLocked": "{count} 个角色已锁定，跳过",
```

确认插入后该 block 末尾（`relType_neutral` 那行）末尾**没有**额外逗号。

- [ ] **Step 2: 英文 key**

打开 `messages/en.json`，找到 `"character": {` 块，在末尾对应位置同样插入：

```json
    "locked": "Locked",
    "lockHint": "Manual upload — skipped during generation",
    "unlock": "Unlock",
    "unlockConfirm": "Unlocking allows the next generation to overwrite this image. Continue?",
    "batchSkippedLocked": "{count} character(s) locked, skipped",
```

- [ ] **Step 3: 验证 JSON 语法**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/zh.json','utf8'));console.log('zh ok')"
node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'));console.log('en ok')"
```

Expected: 两行 `ok`。

- [ ] **Step 4: Commit**

```bash
git add messages/zh.json messages/en.json
git commit -m "i18n: add character lock/unlock copy"
```

---

### Task 11: 端到端手测 + 自查

**Files:** —— 手测，无文件改动。

- [ ] **Step 1: 启动 dev**

```bash
cd /home/wang/codes/AIComicBuilder
npm run dev
```

打开浏览器对一个项目跑：

- [ ] **Step 2: QA checklist（按顺序勾）**

  1. ☐ 选一个项目里的 main 角色，点「上传参考图」上传一张本地拼好的四视图 PNG。
  2. ☐ 上传成功后看到右上锁徽章 (`Locked` / 「已锁定」)。
  3. ☐ 「生成四视图」按钮变灰，鼠标悬停 tooltip 显示 lockHint 文案。
  4. ☐ 点「解锁」(Unlock 图标按钮) → confirm 出现 → 点确认 → 锁徽章消失，「生成四视图」按钮恢复可用。
  5. ☐ 重新点「生成四视图」(确保配置了图像模型) → AI 调用走通，结果出现在卡片中（手工上传的版本进了 history，可用 `<` `>` 切换查看）。
  6. ☐ 重新上传那张本地 PNG（恢复锁定状态）。
  7. ☐ 在 episode 视图点「批量生成四视图」→ 该角色被 skip，其他角色照常处理；toast 显示「1 个角色已锁定，跳过」。
  8. ☐ 进入分镜页，挑一个用到该锁定角色的镜头，触发「首帧生成」→ 在 server log（`/tmp/dev.log` 或 console）确认 `referenceImages` 包含锁定角色的 `referenceImage` 路径。

- [ ] **Step 3: 跑全部新增 + 已有单元测试**

```bash
node --experimental-strip-types --test src/lib/ai/character-image-options.test.ts
node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts
```

Expected: 都 PASS。

- [ ] **Step 4: 编译 + lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: 无 error。

- [ ] **Step 5: 最终 commit（如果 step 1-4 中改了任何东西，归在这一次）**

```bash
git status
# 如果有未提交的微改:
git add -A && git commit -m "chore: post-QA fixups"
```

如果上面全 PASS，无需此 commit。

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | Task |
|---|---|
| 4.1/4.2 schema + migration | Task 1 |
| 5.1 上传锁定 | Task 2 |
| 5.2 PATCH 白名单 | Task 3 |
| 5.3 单角色 handler i2i + early-return | Task 5（依赖 4） |
| 5.4 batch handler skip + i2i | Task 6（依赖 4） |
| 5.5 下游不动 | （明确不动，无 task） |
| 6.1 CharacterCard 徽章 + 解锁 | Task 7 |
| 6.2 inline panel 角标 | Task 8 |
| 6.3 batch toast | Task 9 |
| 6.4 类型扩展 | Task 7 step 1-3, Task 8 step 1 |
| 6.5 i18n 5 key | Task 10 |
| 8.1 单元测试 | Task 4（pure helper） |
| 8.2 手工 QA | Task 11 |

无 spec 章节未覆盖。

**2. Placeholder scan**

- 全部步骤都有具体代码。
- "<PID>"/"<CID>"/"<browser cookie>" 是手测占位，明确标注；不是计划缺失。
- 自动 lint /tsc 命令都给出 expected output。

**3. Type consistency**

- `isLocked: number`（驼峰）在 schema、API body type、CharacterCard prop、Character interface 中一致。
- DB 列名 `is_locked`（蛇形）只出现在 SQL 与 schema.ts 的列定义。
- `buildCharacterImageOptions` 的导出签名在 Task 4 定义，Task 5、Task 6 引用一致。
- Batch handler 返回 `skippedLocked`（驼峰）在 Task 6 定义、Task 9 消费一致。
- 5 个 i18n key 在 Task 10 定义，使用方分布：`character.locked` (Task 7 step 5)、`character.lockHint` (Task 7 step 5/6, Task 8)、`character.unlock` (Task 7 step 7)、`character.unlockConfirm` (Task 7 step 4)、`character.batchSkippedLocked` (Task 9)，全部对得上。

**4. 风险提示**

- Task 6 改动了 `needImages` 过滤条件（加 `&& !c.isLocked`），但锁定角色按设计本来就 _有_ 图，所以原 `!c.referenceImage` 已经会把锁定角色过滤掉；新增条件是冗余但更明确，不影响行为。
- Task 1 step 3 的 journal `idx` 计算，必须以文件中实际最大 idx 为准（plan 给的 54 是参考，按 `_journal.json` 实际最后一项 +1）。

---

Plan complete and saved to `docs/superpowers/plans/2026-06-20-character-fourview-upload-lock.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
