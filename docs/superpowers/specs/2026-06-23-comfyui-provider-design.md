# ComfyUI Provider 集成设计

## 目标

让图片生成和视频生成除了调用第三方 API 外，还能支持本地 ComfyUI。ComfyUI 作为 Provider 协议加入现有架构，并在 UI 设置列表中排在最前面。

## 非目标

- 不把 ComfyUI 做成 Provider 体系外的特殊分支
- 不实现 ComfyUI 工作流可视化编辑器
- 不支持一个 workflow 同时用于图片和视频

## 背景

当前系统通过 `provider-factory.ts` 根据 `Protocol` 创建图片/视频 Provider。`model-store.ts` 管理用户配置的 Provider 和默认模型。`resolveImageProvider` / `resolveVideoProvider` 优先使用项目配置的 Provider，否则 fallback 到环境变量默认 Provider。

ComfyUI 通过提交 workflow JSON 到 `/prompt` 端点生成内容，通过 `/history/{prompt_id}` 轮询结果，通过 `/view?filename=...` 下载输出文件。为了把 ComfyUI 集成进现有流程，需要新增 ComfyUI Provider 实现相同的 `AIProvider` / `VideoProvider` 接口。

## 数据模型

新增 `comfy_workflows` 表：

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

- `projectId` 为空表示全局 workflow，所有项目可用。
- `capability` 限制该 workflow 只能用于图片或视频生成。
- `workflowJson` 保存原始 workflow JSON 字符串。
- `outputNodeId` 首次上传时自动识别（如 `SaveImage`、`VHS_VideoCombine`），用户可手动覆盖。

## Provider 架构

新增文件：

- `src/lib/ai/providers/comfyui-client.ts`：共享 ComfyUI HTTP 客户端，封装 `/prompt`、`/history`、`/view`、`/upload/image` 调用。
- `src/lib/ai/providers/comfyui-image.ts`：实现 `AIProvider`，仅使用 `generateImage`。
- `src/lib/ai/providers/comfyui-video.ts`：实现 `VideoProvider`，仅使用 `generateVideo`。

### comfyui-client.ts 职责

1. 接收 baseUrl、workflow JSON、占位符值、输出节点 ID。
2. 替换 workflow 中的占位符。
3. 把本地图片路径上传到 ComfyUI（`/upload/image`），获取文件名后回填到 LoadImage 节点。
4. 提交 workflow（POST `/prompt`）。
5. 轮询 `/history/{prompt_id}` 直到输出完成或超时。
6. 从输出节点读取文件名，下载到本地 `uploads/` 目录。
7. 返回本地文件路径。

### 占位符规则

支持在 workflow 任意字符串字段中使用：

| 占位符 | 内容 | 适用能力 |
| --- | --- | --- |
| `{{prompt}}` | 正向提示词 | image / video |
| `{{negative_prompt}}` | 反向提示词，默认空字符串 | image / video |
| `{{first_frame}}` | 首帧图片路径 | video |
| `{{last_frame}}` | 尾帧图片路径 | video |
| `{{reference_image}}` | 单张参考图路径 | image / video |
| `{{reference_images}}` | 多张参考图路径，逗号分隔 | image / video |
| `{{width}}` | 从 ratio 解析的宽度 | image / video |
| `{{height}}` | 从 ratio 解析的高度 | image / video |
| `{{duration}}` | 视频时长（秒） | video |
| `{{seed}}` | 随机种子 | image / video |

实现方式：先把 workflow JSON 序列化为字符串，做全局占位符替换，再解析回对象。

对于 `LoadImage` 类节点，占位符值应为已上传到 ComfyUI 的图片文件名；对于 `CLIPTextEncode` 等文本节点，直接替换为文本。

### 输出节点识别

上传 workflow 时，扫描节点 `class_type`：

- 图片输出：`SaveImage`
- 视频输出：`VHS_VideoCombine`、`SaveVideo`、`.mp4` 相关节点

如果自动识别失败，用户可在设置里手动填写 `outputNodeId`。

## UI 设置改动

### Provider 协议列表

在 `src/stores/model-store.ts` 的 `Protocol` 类型中增加 `"comfyui"`：

```typescript
export type Protocol = "comfyui" | "openai" | "gemini" | ...;
```

在 `src/components/settings/provider-form.tsx` 的 `getProtocolOptions` 中，image 和 video 列表都把 ComfyUI 放在第一位：

```typescript
if (capability === "image") {
  return [
    { value: "comfyui", label: "ComfyUI" },
    { value: "openai", label: "OpenAI" },
    // ...
  ];
}

return [
  { value: "comfyui", label: "ComfyUI" },
  { value: "seedance", label: "Seedance" },
  // ...
];
```

### Provider 配置表单

选择 `comfyui` 协议时：

- 显示 Base URL 输入框，默认 `http://127.0.0.1:8188`
- 不需要 API Key（本地 ComfyUI 默认无认证）
- 显示 workflow 选择下拉框，只列出 capability 匹配的 workflow（全局 + 当前项目）
- 提供跳转到 workflow 管理页面的入口

### Workflow 管理页面

新增 `/project/[id]/settings/comfy-workflows` 或弹窗：

- 上传 workflow JSON 文件
- 输入名称
- 选择 capability（image / video）
- 显示自动识别的输出节点 ID，允许手动修改
- 显示占位符参考列表
- 列出已上传 workflow，支持删除

## 错误处理

| 场景 | 行为 |
| --- | --- |
| 无法连接 ComfyUI | 返回错误："无法连接到 ComfyUI，请确认已启动并检查 Base URL" |
| workflow 未找到 | 返回错误："未找到关联的 ComfyUI workflow" |
| 输出节点未识别且未手动指定 | 返回错误："未找到输出节点，请在 workflow 设置中指定" |
| workflow 中没有 `{{prompt}}` | 允许提交，记录警告日志 |
| 生成超时 | 默认 5 分钟轮询超时，返回错误 |
| ComfyUI 节点执行报错 | 透传 ComfyUI 返回的错误信息 |

## 兼容性

- 不影响现有 API Provider 的使用方式。
- 如果用户未配置 ComfyUI Provider，行为与现在完全一致。
- `resolveImageProvider` / `resolveVideoProvider` 仍按 modelConfig 选择；ComfyUI 作为普通 Protocol 参与选择。

## 后续可扩展

- 支持 workflow 参数表单：根据 workflow 中的节点自动生成输入字段
- 支持多个输出节点
- 支持 ComfyUI 队列状态展示
