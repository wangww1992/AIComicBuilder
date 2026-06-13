import type { AIProvider } from "../types";

/**
 * Compress a prompt that exceeds `maxLength` characters.
 *
 * Strategy:
 *   1. If the prompt already fits, return as-is (zero cost).
 *   2. If a text LLM is wired in, ask it to rewrite the prompt in the
 *      same language, preserving visual details.
 *   3. If the LLM is unavailable, fails, or its rewrite still overflows,
 *      fall back to a hard slice with an ellipsis so the request still
 *      goes through. Worst case the image loses some fidelity, but we
 *      never crash with a 2013 error.
 *
 * Exported as a standalone function (no class dependency, no `@/`
 * imports) so the test suite can drive it with a fake text provider.
 */
export async function compressPrompt(
  prompt: string,
  maxLength: number,
  textProvider?: AIProvider,
): Promise<string> {
  if (prompt.length <= maxLength) return prompt;

  const overBy = prompt.length - maxLength;
  console.warn(
    `[compressPrompt] Prompt is ${prompt.length} chars (over by ${overBy}); compressing to ${maxLength}...`,
  );

  if (textProvider) {
    try {
      const compressed = await textProvider.generateText(
        COMPRESS_INSTRUCTION.replace("{MAX}", String(maxLength)) +
          "\n\n---\n\n" +
          prompt,
        { temperature: 0.3 },
      );
      if (compressed.length <= maxLength) {
        console.log(
          `[compressPrompt] LLM compressed ${prompt.length} → ${compressed.length} chars`,
        );
        return compressed;
      }
      console.warn(
        `[compressPrompt] LLM output still ${compressed.length} chars; truncating.`,
      );
      return compressed.slice(0, maxLength - 3) + "...";
    } catch (err) {
      console.warn(
        `[compressPrompt] LLM compression failed (${
          err instanceof Error ? err.message : err
        }); falling back to hard slice.`,
      );
    }
  } else {
    console.warn(
      "[compressPrompt] No text LLM provided; falling back to hard slice.",
    );
  }

  return prompt.slice(0, maxLength - 3) + "...";
}

const COMPRESS_INSTRUCTION = `You are compressing an image-generation prompt. The output MUST be at most {MAX} characters (the image model's hard limit) and MUST stay in the SAME LANGUAGE as the input.

Preserve, in roughly this priority order:
1. Subject identity and action (who/what, doing what)
2. Visual style and art direction (e.g. "cinematic", "anime", "photorealistic")
3. Composition, framing, camera angle, lens
4. Lighting, color palette, mood
5. Costume, props, background detail
6. Any negative cues ("no text", "no watermark")

Drop: filler words, redundant adjectives, meta-instructions ("this is for..."), and any sentence that doesn't change the picture.

Output ONLY the compressed prompt — no explanation, no quotes, no preamble.`;
