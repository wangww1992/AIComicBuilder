import { OpenAIProvider } from "./providers/openai";
import { GeminiProvider } from "./providers/gemini";
import { SeedanceProvider } from "./providers/seedance";
import { VeoProvider } from "./providers/veo";
import { KlingImageProvider } from "./providers/kling-image";
import { KlingVideoProvider } from "./providers/kling-video";
import { WanVideoProvider } from "./providers/wan-video";
import { UCloudSeedanceProvider } from "./providers/ucloud-seedance";
import { ArkImageProvider } from "./providers/ark-image";
import { DashScopeImageProvider } from "./providers/dashscope-image";
import { MiniMaxImageProvider } from "./providers/minimax-image";
import { MiniMaxVideoProvider } from "./providers/minimax-video";
import { ComfyUIImageProvider } from "./providers/comfyui-image";
import { ComfyUIVideoProvider } from "./providers/comfyui-video";
import { getAIProvider, getVideoProvider } from "./index";
import type { AIProvider, VideoProvider } from "./types";

interface ProviderConfig {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  secretKey?: string;
  modelId: string;
  workflowId?: string;
}

export interface ModelConfigPayload {
  text?: ProviderConfig | null;
  image?: ProviderConfig | null;
  video?: ProviderConfig | null;
}

export function createAIProvider(
  config: ProviderConfig,
  uploadDir?: string,
  /**
   * Optional text LLM passed through to image providers that need to
   * compress prompts (e.g. MiniMax's 1500-char cap). Only providers
   * that actually need it will look at this.
   */
  textProvider?: AIProvider,
): AIProvider {
  switch (config.protocol) {
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "kling":
      return new KlingImageProvider({
        apiKey: config.apiKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "dashscope":
      return new DashScopeImageProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "ark":
      return new ArkImageProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "minimax":
      return new MiniMaxImageProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
        ...(textProvider && { textProvider }),
      });
    case "comfyui":
      if (!config.workflowId) throw new Error("ComfyUI provider requires a workflowId");
      return new ComfyUIImageProvider({
        baseUrl: config.baseUrl,
        workflowId: config.workflowId,
        uploadDir: uploadDir ?? process.env.UPLOAD_DIR ?? "./uploads",
      });
    default:
      throw new Error(`Unsupported AI protocol: ${config.protocol}`);
  }
}

export function createVideoProvider(config: ProviderConfig, uploadDir?: string): VideoProvider {
  switch (config.protocol) {
    case "seedance":
      return new SeedanceProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "gemini":
      return new VeoProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "kling":
      return new KlingVideoProvider({
        apiKey: config.apiKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "wan":
      return new WanVideoProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "ucloud-seedance":
      return new UCloudSeedanceProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "minimax":
      return new MiniMaxVideoProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "comfyui":
      if (!config.workflowId) throw new Error("ComfyUI provider requires a workflowId");
      return new ComfyUIVideoProvider({
        baseUrl: config.baseUrl,
        workflowId: config.workflowId,
        uploadDir: uploadDir ?? process.env.UPLOAD_DIR ?? "./uploads",
      });
    default:
      throw new Error(`Unsupported video protocol: ${config.protocol}`);
  }
}

export function resolveAIProvider(modelConfig?: ModelConfigPayload): AIProvider {
  if (modelConfig?.text) {
    return createAIProvider(modelConfig.text);
  }
  return getAIProvider();
}

export function resolveImageProvider(modelConfig?: ModelConfigPayload, uploadDir?: string): AIProvider {
  if (modelConfig?.image) {
    // Hand the project's text LLM to the image provider so providers
    // like MiniMax (which have a hard prompt-length cap) can use it to
    // compress oversize prompts. Other providers ignore the argument.
    const textProvider = modelConfig.text
      ? createAIProvider(modelConfig.text)
      : undefined;
    return createAIProvider(modelConfig.image, uploadDir, textProvider);
  }
  return getAIProvider(uploadDir);
}

export function resolveVideoProvider(modelConfig?: ModelConfigPayload, uploadDir?: string): VideoProvider {
  if (modelConfig?.video) {
    return createVideoProvider(modelConfig.video, uploadDir);
  }
  return getVideoProvider(uploadDir);
}
