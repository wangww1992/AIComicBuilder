# 角色四视图本地上传 + 锁定保护 设计

**Date:** 2026-06-20
**Status:** Approved (pending implementation)

## 1. 背景

项目已支持 AI 生成角色四视图（turnaround）和「上传参考图」，但两者共用一个字段 `characters.reference_image`：

- 用户在 SD/MJ/PS 等本地工具里手工做好的四视图拼图，上传上去会被一并存进 `reference_image`。
- 但点击「生成四视图」(`single_character_image`) 或「批量生成」(`batch_character_image`) 会无差别覆盖这张图，把用户的手工版冲掉。
- 单角色重生从未把已有的 `reference_image` 当 image-to-image 的 reference 喂回去 —— 即使下游分镜首帧已经在用 `reference_image` 做 reference。

## 2. 目标

1. 用户上传的四视图被自动「锁定」，不被任何 AI 重生流程覆盖。
2. 单角色重生（解锁状态下）把当前 `reference_image` 作为 reference 传入，画风更稳。
3. 用户可通过 UI 显式解锁，需要时让 AI 重新生成。
4. 下游分镜首帧无须改动 —— 它本来就读 `reference_image`，对来源无感知。

## 3. 非目标

- 不拆分「上传图」和「生成图」字段。
- 不引入多张参考图（一个角色只能有一张当前 `reference_image`）。
- 不引入对象存储 / S3。本地文件系统不变。
- 不修改 prompt 模板（`character_image` registry 和 `character-image.ts` 都保持现状）。

## 4. 数据模型

### 4.1 Schema 变更

`src/lib/db/schema.ts` 的 `characters` 表新增一列：

```ts
isLocked: integer("is_locked").notNull().default(0),
```

值域：`0 = 未锁定`，`1 = 已锁定`。

### 4.2 Migration

新建 `drizzle/0054_add_character_is_locked.sql`：

```sql
ALTER TABLE characters ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;
```

### 4.3 语义表

| `is_locked` | `reference_image` | 含义 |
|---|---|---|
| 0 | null | 还没生成图 |
| 0 | 任意路径 | AI 生成的（或之前解锁后再生成的） |
| 1 | 必有 | 用户手工上传，所有重生流程跳过 |

## 5. 后端

### 5.1 上传路由：上传即锁定

`src/app/api/projects/[id]/characters/[characterId]/upload/route.ts`

写库时把 `isLocked: 1` 一起 set：

```ts
.set({
  referenceImage: filepath,
  referenceImageHistory: JSON.stringify(history),
  isLocked: 1,
})
```

`referenceImageHistory` 的 push 行为不变。已锁定状态下再次上传：直接覆盖，仍保持锁定（无解锁需要）。

### 5.2 PATCH 路由：允许 toggle

`src/app/api/projects/[id]/characters/[characterId]/route.ts` 的 PATCH handler 在白名单里新增 `isLocked`，接受 `0 | 1`。前端用它做解锁。

### 5.3 单角色重生 handler

`src/app/api/projects/[id]/generate/route.ts` `handleSingleCharacterImage` (line ~918)：

- 取到 character 后、调用 `ai.generateImage` 之前，加锁定 early-return：

```ts
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
```

- `ai.generateImage(...)` 调用时，把已有的 `referenceImage` 作 reference 喂回去：

```ts
const imagePath = await ai.generateImage(prompt, {
  size: "2560x1440",
  aspectRatio: "16:9",
  quality: "hd",
  ...(character.referenceImage && {
    referenceImages: [character.referenceImage],
    referenceLabels: [character.name],
  }),
});
```

因为 `isLocked=1` 已经 early-return，到这里 `referenceImage` 必然不是手工上传的（只能是上一次 AI 输出），喂回去只产生「按上一版风格继续迭代」的效果。

「stale shots」逻辑（line ~967–988）保持原状，锁定时不会执行，正确。

### 5.4 批量重生 handler

同文件 `handleBatchCharacterImage` (line ~999) 的循环：

```ts
for (const character of charactersToProcess) {
  if (character.isLocked) {
    results.push({ characterId: character.id, status: "skipped_locked" });
    continue;
  }
  ...
  const imagePath = await ai.generateImage(prompt, {
    ...,
    ...(character.referenceImage && {
      referenceImages: [character.referenceImage],
      referenceLabels: [character.name],
    }),
  });
  ...
}
```

返回汇总把 `skipped_locked` 的计数单列出来，便于前端 toast。

### 5.5 下游分镜首帧：不改

`generate/route.ts:1789` 的 `charsWithImages.filter(c => c.referenceImage)` 不区分来源 —— 锁定的图照样被传去做分镜首帧 reference，正是我们要的。

## 6. 前端

### 6.1 CharacterCard (`src/components/editor/character-card.tsx`)

- 卡片右上加锁徽章，仅 `isLocked === 1` 时显示。Tooltip：「手工上传的参考图，自动生成时跳过」。
- 「生成四视图」按钮在 `isLocked === 1` 时 disabled，tooltip：「角色已锁定，请先解锁」。
- 在 Sparkles / Upload 那排按钮里新增「解锁」按钮（`<Unlock>` 图标），仅 `isLocked === 1` 时显示。点击弹 confirm：「解锁后再次生成四视图会覆盖当前图，确定？」→ 调 `PATCH { isLocked: 0 }`。

### 6.2 CharactersInlinePanel (`src/components/editor/characters-inline-panel.tsx`)

80×80 缩略图右上加小锁角标（仅视觉提示，不挡绿/黄状态点）。无交互。

### 6.3 角色列表页 (`/[locale]/project/[id]/characters/page.tsx`)

「批量生成四视图」按钮行为不变。生成完成的 toast 在 `skipped_locked > 0` 时追加一行：「N 个角色已锁定，跳过」。

### 6.4 类型扩展

前端 `Character` 类型（`src/components/editor/character-card.tsx` 或共享 types 处）增加 `isLocked: number`。GET `/characters` 用 `db.select()` 返回全列，无需改路由。

### 6.5 i18n

`messages/zh.json` + `messages/en.json` 在 `character.*` 下新增 5 个 key：

| key | zh | en |
|---|---|---|
| `character.locked` | 已锁定 | Locked |
| `character.lockHint` | 手工上传的参考图，自动生成时跳过 | Manual upload — skipped during generation |
| `character.unlock` | 解锁 | Unlock |
| `character.unlockConfirm` | 解锁后再次生成四视图会覆盖当前图，确定？ | Unlocking allows the next generation to overwrite this image. Continue? |
| `character.batchSkippedLocked` | {count} 个角色已锁定，跳过 | {count} character(s) locked, skipped |

## 7. API 形态

| Endpoint | 方法 | 变化 |
|---|---|---|
| `/projects/[id]/characters/[cid]/upload` | POST | 写库时 `isLocked = 1` |
| `/projects/[id]/characters/[cid]` | PATCH | 白名单加 `isLocked` |
| `/projects/[id]/generate` action `single_character_image` | POST | locked → 409 `{status: "skipped_locked"}` |
| `/projects/[id]/generate` action `batch_character_image` | POST | locked → 计入 `skipped_locked` 数组，不抛 |

## 8. 测试

### 8.1 单元测试

参考 `src/lib/ai/ai-sdk.test.ts` 的就近共置风格，新建一个 `*.test.ts`（位置由实施者按现有测试组织决定）：

- `handleSingleCharacterImage` 在 `isLocked=1` 时返回 409 + `status: "skipped_locked"`，且不调用 image provider。
- `handleSingleCharacterImage` 在 `isLocked=0` 且 `referenceImage` 非空时，调用 provider 时透传 `referenceImages: [path]` + `referenceLabels: [name]`。
- `handleBatchCharacterImage` 在混合锁定/未锁定角色集合上：未锁定全部生成、锁定全部 `skipped_locked`、汇总计数正确。

Provider 用 mock，不打真实网络。

### 8.2 手工测试脚本（QA checklist）

1. 准备一张本地拼好的角色四视图 PNG。
2. 在角色卡上点「上传参考图」选择该 PNG → 看到锁徽章出现。
3. 点「生成四视图」按钮 → 应被 disable 且 tooltip 显示锁定原因。
4. 点「解锁」→ confirm → 锁徽章消失，「生成四视图」恢复可用。
5. 重新点「生成四视图」→ AI 调用成功，结果覆盖原图（手工版进了 history）。
6. 重新上传该手工 PNG（恢复锁定）→ 跑「批量生成四视图」→ 该角色被 skip，其他角色照常生成；toast 显示「1 个角色已锁定，跳过」。
7. 在分镜页生成首帧 → 检查 prompt 调用确实带上了上传的手工图作 reference。

## 9. 实施顺序提示

1. Schema + migration（先跑迁移，DB 拿到新列）。
2. PATCH 路由白名单 + 上传路由写 isLocked。
3. 两个 generate handler 改造。
4. 前端 CharacterCard / inline panel / list page。
5. i18n。
6. 单元测试。
7. 手工 QA。

## 10. 风险与回滚

- 风险：旧数据 `is_locked` 默认 0，对所有现有角色无影响。
- 回滚：drop 列即可，handler 里的 `isLocked` 检查会变成 `undefined && ...` falsy，自然回到原行为；前端缺字段时徽章不渲染，不崩。
