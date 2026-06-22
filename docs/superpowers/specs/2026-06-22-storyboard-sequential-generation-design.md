# 分镜管理：先摘要、后逐个生成设计

**Date:** 2026-06-22
**Status:** Approved (pending implementation)

## 1. 背景

当前分镜生成（`shot_split`）是一次性调用 LLM，把剧本按场景分块并行生成全部镜头，再统一写入数据库。存在几个问题：

- 用户无法在生成前看到整体分镜规划（节奏、场景分布、总镜头数）。
- 一次性生成全部镜头，耗时长、失败成本高；某个镜头出错时需要整体重跑或手动逐个修复。
- 现有「单镜头重生成」只能基于当前镜头字段改写，无法利用全局摘要和剧本上下文。

## 2. 目标

1. 先生成一个可编辑的「分镜摘要」文本，让用户在生成具体镜头前了解整体规划。
2. 摘要确认后，系统自动按顺序逐个生成分镜，直至全部完成，而不是一次生成全部。
3. 单个已生成分镜支持基于最新摘要 + 剧本上下文重新生成或微调。
4. 摘要可编辑，编辑后的摘要会影响后续未生成分镜以及重生成操作。

## 3. 非目标

- 不替换现有的 `shot_split` 一次性生成能力，而是新增一套「摘要 + 逐个生成」流程。
- 不引入独立的任务队列或调度系统；复用现有的 HTTP 流式响应 + 数据库存盘机制。
- 不新增 shot 级别的版本历史；单个镜头重生成原地覆盖当前行。
- 不支持严格意义上的「暂停 / 继续」按钮；通过刷新后「继续生成」实现断点恢复。

## 4. 数据模型

### 4.1 Schema 变更

`src/lib/db/schema.ts` 的 `episodes` 表和 `projects` 表各新增两列：

```ts
// episodes
storyboardSummary: text("storyboard_summary").default(""),
storyboardPlan: text("storyboard_plan").default(""),

// projects（用于非分集模式）
storyboardSummary: text("storyboard_summary").default(""),
storyboardPlan: text("storyboard_plan").default(""),
```

- `storyboardSummary`：用户可见、可编辑的自然语言摘要。
- `storyboardPlan`：后端使用的结构化计划，JSON 字符串，包含 `totalShots` 和场景列表。

### 4.2 Migration

新建 `drizzle/0054_add_storyboard_summary_plan.sql`：

```sql
ALTER TABLE episodes ADD COLUMN storyboard_summary TEXT DEFAULT '';
ALTER TABLE episodes ADD COLUMN storyboard_plan TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN storyboard_summary TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN storyboard_plan TEXT DEFAULT '';
```

### 4.3 状态跟踪

继续使用现有表：

- `storyboardVersions`：每次生成摘要创建一个新 version。
- `shots` / `dialogues` / `scenes`：逐镜头生成时逐步写入。
- `shots.status`：用于标记 `pending` / `generating` / `completed` / `failed`，实现中断恢复。

生成进度通过统计当前 version 下 `status = 'completed'` 的 `shots` 数量来计算。

## 5. 后端

### 5.1 PATCH 路由扩展

为了让前端保存摘要编辑，需要在现有 PATCH 路由的白名单中新增字段：

- `src/app/api/projects/[id]/route.ts` 的 `PATCH`：新增 `storyboardSummary`、`storyboardPlan`。
- `src/app/api/projects/[id]/episodes/[episodeId]/route.ts` 的 `PATCH`：新增 `storyboardSummary`、`storyboardPlan`。

### 5.2 摘要生成

在 `src/app/api/projects/[id]/generate/route.ts` 新增处理：

```ts
if (action === "generate_storyboard_summary") {
  return handleGenerateStoryboardSummary(projectId, userId, modelConfig, episodeId);
}
```

行为：

- 读取剧本、角色、世界观、目标时长、生成模式。
- 调用 LLM，要求输出 JSON：

```json
{
  "summary": "自然语言摘要...",
  "plan": {
    "totalShots": 12,
    "scenes": [
      {
        "title": "酒馆对峙",
        "description": "...",
        "lighting": "...",
        "colorPalette": "...",
        "shotCount": 4
      }
    ]
  }
}
```

- 将 `summary` 和 `plan` 写入 `episodes` / `projects`。
- 返回文本流，让前端实时看到摘要内容。

### 5.3 逐镜头顺序生成

新增 action：

```ts
if (action === "start_sequential_shot_generation") {
  return handleStartSequentialShotGeneration(projectId, userId, payload, modelConfig, episodeId);
}
```

行为：

- 读取当前 `storyboardSummary` / `storyboardPlan`。
- 创建新的 `storyboardVersions` 记录。
- 从 `plan.totalShots` 和当前 version 已 completed 的镜头数，计算剩余镜头。
- 循环生成每个镜头：
  - 根据累计数判断当前属于哪个 scene，必要时先插入 `scenes` 记录。
  - 构造 per-shot prompt：摘要 + 当前 scene 信息 + 剧本对应片段 + 上一两个已生成镜头（保证连贯性）+ 当前序号。
  - 调用 LLM 生成单个镜头 JSON。
  - 写入 `shots` / `dialogues`。
  - 推送 NDJSON 事件：`{ type: "shot_done", index, total, shotId }`。
- 全部完成后推送 `{ type: "done", totalShots }`。

### 5.4 继续生成

新增 action：

```ts
if (action === "continue_sequential_shot_generation") {
  return handleContinueSequentialShotGeneration(...);
}
```

行为与 `start_sequential_shot_generation` 类似，但：

- 不创建新 version，复用当前选中的 version。
- 扫描该 version 下 `status = 'completed'` 的镜头，从下一个序号继续。
- 将 `status = 'generating'` 的镜头视为上次异常中断，先重置为 `pending` 再处理。

### 5.5 单镜头基于摘要重生成

新增 action：

```ts
if (action === "regenerate_single_shot") {
  return handleRegenerateSingleShot(projectId, userId, payload, modelConfig, episodeId);
}
```

行为：

- 读取当前 `storyboardSummary` 和对应 shot 的剧本上下文。
- 构造与逐镜头生成相同的 prompt，同时传入该 shot 当前字段作为参考。
- 生成新的镜头 JSON。
- 原地更新该 `shots` 行（以及关联的 `dialogues`）。

## 6. Prompt 策略

### 6.1 摘要生成 Prompt

输入：剧本、角色描述、角色关系、世界观、目标时长、生成模式。

约束：

- `summary` 必须是自然语言，说明整体节奏、场景分布、情感曲线、总镜头数。
- `plan.totalShots` 必须准确。
- `plan.scenes` 用于后端驱动，不展示给用户。

### 6.2 逐镜头生成 Prompt

输入：

- `summary`
- 当前 scene 的 title / description / lighting / colorPalette
- 剧本中对应片段
- 上一两个已生成镜头的 JSON（用于 continuity）
- 当前 shot index / totalShots
- 生成模式（keyframe / reference）

约束：

- 只输出第 `i` 个镜头，不要输出其他镜头。
- 当前镜头的 `startFrame` 要与上一镜头的 `endFrame` 在角色位置、环境、光影上自然衔接。
- 输出字段与现有 `shot_split` 一致。

### 6.3 单镜头重生成 Prompt

与逐镜头生成 prompt 相同，额外加入：

- 该 shot 当前已有字段（作为参考，允许覆盖）。
- 用户编辑后的最新 `summary`。

## 7. 前端

### 7.1 新增组件

#### `StoryboardSummaryPanel`

位置：分镜页面「批量操作」区域上方。

状态：

- 未生成：显示「生成分镜摘要」按钮。
- 生成中：显示流式文本 + loading。
- 已生成：显示可编辑文本框 + 「开始逐个生成分镜」按钮；如果当前 version 有未完成的镜头，按钮文案变为「继续生成分镜」。

编辑摘要后 onBlur 调用 PATCH 保存到 episode/project。

#### `SequentialGenerationProgress`

开始逐个生成后显示：

- 进度条：当前已完成 / 总数。
- 文本：「正在生成分镜 3 / 12」。
- 已用时间。

#### ShotCard 扩展

每个已生成镜头新增「基于摘要重生成」按钮，与现有字段级编辑、普通重生成按钮共存。

### 7.2 主页面状态

新增状态：

```ts
const [generatingSummary, setGeneratingSummary] = useState(false);
const [summaryText, setSummaryText] = useState("");
const [generatingShotIndex, setGeneratingShotIndex] = useState<number | null>(null);
const [totalPlannedShots, setTotalPlannedShots] = useState(0);
```

### 7.3 数据流

1. 点击「生成分镜摘要」
   → POST `action=generate_storyboard_summary`
   → 流式接收文本
   → 保存到本地状态，流结束时 `fetchProject`

2. 点击「开始逐个生成分镜」
   → POST `action=start_sequential_shot_generation`
   → NDJSON 流：`shot_start`、`shot_done`、`error`、`done`
   → 每收到 `shot_done` 更新 `generatingShotIndex`
   → `done` 后 `fetchProject`、清空进度

3. 编辑摘要
   → PATCH episode/project
   → 后续生成/重生成自动读取最新摘要

4. 点击「基于摘要重生成」
   → POST `action=regenerate_single_shot` + shotId
   → 完成后 `fetchProject`

### 7.4 新增 i18n 键

- `storyboard.generateSummary`
- `storyboard.summaryPlaceholder`
- `storyboard.startSequentialGeneration`
- `storyboard.continueGeneration`
- `storyboard.generatingShotNOfM`
- `storyboard.regenerateFromSummary`
- `storyboard.summaryGenerated`

## 8. 错误处理与边界情况

- **摘要生成失败**：流中返回 `error` 事件，UI toast 提示；不保存半成品。
- **单个镜头失败**：标记该镜头 `status = failed`，继续生成下一个；失败镜头提供重试按钮。
- **连续失败**：若连续失败超过 3 个，自动停止并提示用户检查模型或摘要。
- **页面刷新中断**：刷新后，未完成的镜头以 `generating` 或 `pending` 状态保留；用户点击「继续生成」恢复。
- **摘要中途编辑**：已生成镜头不受影响；后续镜头和重生成使用新摘要。
- **totalShots 与实际剧本不符**：模型可提前结束；后端检测无有效输出时停止，不强制生成空镜头。
- **空剧本/无模型配置**：返回明确 400/422 错误。

## 9. 测试计划

- 单元测试：
  - `src/lib/ai/prompts/storyboard-summary.ts`：验证 prompt 包含必要字段。
  - 摘要解析：验证 LLM 输出可正确拆分为 `summary` 和 `plan`。
- API 测试：
  - `generate_storyboard_summary` 返回流并正确写入数据库。
  - `start_sequential_shot_generation` 按顺序生成指定数量镜头。
  - `regenerate_single_shot` 原地覆盖目标 shot。
  - 中断后继续生成从正确位置恢复。
- 前端测试：
  - `StoryboardSummaryPanel` 状态流转。
  - 进度条随 `shot_done` 事件更新。

## 10. 关键文件清单

- `src/lib/db/schema.ts`
- `drizzle/0054_add_storyboard_summary_plan.sql`
- `src/app/api/projects/[id]/route.ts`（PATCH 白名单扩展）
- `src/app/api/projects/[id]/episodes/[episodeId]/route.ts`（PATCH 白名单扩展）
- `src/app/api/projects/[id]/generate/route.ts`
- `src/lib/ai/prompts/storyboard-summary.ts`（新建）
- `src/lib/ai/prompts/sequential-shot-generate.ts`（新建）
- `src/app/[locale]/project/[id]/episodes/[episodeId]/storyboard/page.tsx`
- `src/components/editor/storyboard-summary-panel.tsx`（新建）
- `src/components/editor/sequential-generation-progress.tsx`（新建）
- `src/components/editor/shot-card.tsx`
- `messages/zh.json`
- `messages/en.json`
