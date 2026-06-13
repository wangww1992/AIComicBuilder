import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export interface ProviderConfig {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  secretKey?: string;
  modelId: string;
}

export function createLanguageModel(config: ProviderConfig): LanguageModel {
  switch (config.protocol) {
    case "openai": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      return provider.chat(config.modelId);
    }
    case "anthropic": {
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      return provider(config.modelId);
    }
    case "gemini": {
      const provider = createGoogleGenerativeAI({
        apiKey: config.apiKey,
      });
      return provider(config.modelId);
    }
    default:
      throw new Error(`Unsupported protocol: ${config.protocol}`);
  }
}

/**
 * Strip reasoning / chain-of-thought blocks from an AI response.
 *
 * Background: reasoning-capable models (Qwen3, DeepSeek-R1, GLM-4, ...)
 * wrap their chain-of-thought in some tag BEFORE the final answer:
 *   - `<think>...</think>`            (Qwen3 / GLM-4 / many OSS)
 *   - `<|begin▁of▁think|>...<|end▁of▁think|>`  (DeepSeek-R1 unicode)
 *   - `<|begin_of_think|>...<|end_of_think|>`  (DeepSeek-R1 underscore)
 *   - `<reasoning>...</reasoning>`    (some HuggingFace endpoints)
 *   - `<reflection>...</reflection>`  (some HuggingFace endpoints)
 *
 * Use this:
 *   - for plain-text output that you display or save (e.g. streaming
 *     outlines / scripts via `onFinish` / `flush`),
 *   - or before feeding text into a JSON parser. `extractJSON` calls
 *     this for you.
 */
export function stripThinking(text: string): string {
  return text
    // Most specific first so a nested opener doesn't accidentally
    // swallow part of the real answer.
    .replace(/<\|begin▁of▁think\|>[\s\S]*?<\|end▁of▁think\|>/gi, "")
    .replace(/<\|begin_of_think\|>[\s\S]*?<\|end_of_think\|>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, "");
}

/**
 * Strip markdown code fences and reasoning blocks from an AI response
 * so the result is a string `JSON.parse` can handle. The reasoning-block
 * pass delegates to `stripThinking` so JSON and text paths share the
 * same definition of what a "think tag" is.
 *
 * Pipeline:
 * 1. Strip known reasoning tags.
 * 2. Drop raw control characters that break JSON.parse.
 * 3. Unwrap ```json / ``` fences if present.
 * 4. Fall back to scanning for the first balanced {…} or […] in the text
 *    so that prose preambles like "Sure, here is the JSON: {...}" work.
 */
export function extractJSON(text: string): string {
  // 1. Reasoning tags.
  let cleaned = stripThinking(text);

  // 2. Raw control characters that JSON.parse rejects (keep \n \r \t).
  cleaned = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

  // 3. Markdown code fence.
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // 4. First balanced JSON object or array — handles prose preambles.
  return extractFirstBalancedJSON(cleaned).trim();
}

/**
 * Find the first `{` or `[` in `text` and return the substring that
 * contains the matching closer, correctly skipping over brackets that
 * appear inside quoted strings. Returns the original text if no opener
 * is found (so the caller still sees a parse error rather than `""`).
 */
function extractFirstBalancedJSON(text: string): string {
  let start = -1;
  let opener = "";
  let closer = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") {
      start = i;
      opener = c;
      closer = c === "{" ? "}" : "]";
      break;
    }
  }
  if (start === -1) return text;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      // Previous char was a backslash inside a string — consume this one
      // literally regardless of what it is.
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === opener) {
      depth++;
    } else if (c === closer) {
      depth--;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  return text;
}
