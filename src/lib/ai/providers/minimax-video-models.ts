/**
 * Pure validation + resolution-derivation helpers for the MiniMax
 * video-generation endpoint.
 *
 * The actual `minimax-video.ts` provider imports `@/lib/id` and `node:fs`,
 * which the `node --experimental-strip-types --test` runner can't
 * resolve. The validation rules below don't touch the filesystem — they
 * are extracted here so the existing test suite can pin them down.
 *
 * No `@/`-aliased imports (matches `ark-models.ts`, `anthropic-models.ts`).
 */

// ── Mode classification ──────────────────────────────────────────────

export type MiniMaxVideoMode = "t2v" | "i2v" | "keyframe" | "subject_ref";

/**
 * Models the docs list under the image-to-video (I2V) endpoint.
 * `MiniMax-Hailuo-02` is included because it serves both I2V AND the
 * start-end (keyframe) mode — the only model that does the latter.
 * `I2V-01-Director` / `I2V-01-live` / `I2V-01` are kept for the older
 * I2V-only family (720P, 6s only).
 */
export const MINIMAX_I2V_MODELS = [
  "MiniMax-Hailuo-2.3",
  "MiniMax-Hailuo-2.3-Fast",
  "MiniMax-Hailuo-02",
  "I2V-01-Director",
  "I2V-01-live",
  "I2V-01",
] as const;

/** Models that support the start-end (keyframe) endpoint. Per docs,
 *  this is `MiniMax-Hailuo-02` ONLY — no other model accepts both
 *  `first_frame_image` and `last_frame_image`. */
export const MINIMAX_KEYFRAME_MODELS = ["MiniMax-Hailuo-02"] as const;

export function isKeyframeSupported(model: string): boolean {
  return (MINIMAX_KEYFRAME_MODELS as readonly string[]).includes(model);
}

// ── Validation ──────────────────────────────────────────────────────

/** Error message produced by `validateMiniMaxVideoRequest`. `null`
 *  means the request is valid. Callers should `throw new Error(msg)`
 *  when non-null — these strings are meant to be user-visible. */
export function validateMiniMaxVideoRequest(input: {
  model: string;
  mode: MiniMaxVideoMode;
  duration: number;
  resolution?: string;
}): string | null {
  const { model, mode, duration, resolution } = input;

  // 1) Keyframe mode is the most restrictive — pin it to Hailuo-02 up
  //    front so users with Hailuo-2.3 configured get a clear error
  //    instead of a cryptic API 1026.
  if (mode === "keyframe" && !isKeyframeSupported(model)) {
    return (
      `MiniMax model "${model}" does not support the start-end ` +
      `(first+last frame) mode. Only ${MINIMAX_KEYFRAME_MODELS.join(", ")} ` +
      `support it. Update the configured model or switch the shot to ` +
      `single-frame (i2v).`
    );
  }

  // 2) Subject-reference mode is S2V-01 only.
  if (mode === "subject_ref" && model !== "S2V-01") {
    return (
      `MiniMax subject-reference mode requires model "S2V-01"; ` +
      `got "${model}".`
    );
  }

  // 3) If a resolution was specified, validate it against what the
  //    model+duration combo actually supports. Skipped when resolution
  //    is undefined (caller wants the default).
  if (resolution) {
    const allowed = allowedResolutionsFor(model, duration);
    if (!allowed.includes(resolution)) {
      return (
        `MiniMax model "${model}" with duration=${duration}s does not ` +
        `support resolution "${resolution}". Allowed: ${allowed.join(", ")}.`
      );
    }
  }

  return null;
}

// ── Resolution tables ────────────────────────────────────────────────

/** Hailuo family (2.3 / 2.3-Fast / 02) — full table per docs. */
const HAILUO_RESOLUTION_TABLE: Record<number, readonly string[]> = {
  // 6s: 768P default or 1080P (plus 512P for Hailuo-02 i2v only)
  6: ["768P", "1080P"],
  // 10s: 768P only
  10: ["768P"],
};

/** Older I2V-01 family — 720P, 6s only. */
const I2V01_RESOLUTION_TABLE: Record<number, readonly string[]> = {
  6: ["720P"],
};

/**
 * Per the I2V docs, `MiniMax-Hailuo-02` also supports `512P` (in I2V
 * mode). We allow it as an extra option at 6s/10s. The start-end docs
 * explicitly say keyframe doesn't support 512P — that case is handled
 * separately in `validateMiniMaxVideoRequest` (we restrict the table
 * to 768P/1080P for keyframe mode).
 */
function isHailuo02(model: string): boolean {
  return model === "MiniMax-Hailuo-02";
}

function isHailuoFamily(model: string): boolean {
  return (
    model === "MiniMax-Hailuo-2.3" ||
    model === "MiniMax-Hailuo-2.3-Fast" ||
    model === "MiniMax-Hailuo-02"
  );
}

function isI2V01Family(model: string): boolean {
  return (
    model === "I2V-01-Director" || model === "I2V-01-live" || model === "I2V-01"
  );
}

export function allowedResolutionsFor(
  model: string,
  duration: number,
  opts: { keyframeMode?: boolean } = {},
): readonly string[] {
  if (isHailuoFamily(model)) {
    const base = HAILUO_RESOLUTION_TABLE[duration] ?? [];
    if (isHailuo02(model) && duration === 6 && !opts.keyframeMode) {
      // 512P is I2V-only per the I2V docs; keyframe docs say 512P is
      // not supported.
      return ["512P", ...base];
    }
    return base;
  }
  if (isI2V01Family(model)) {
    return I2V01_RESOLUTION_TABLE[duration] ?? [];
  }
  // S2V-01 and any unrecognized model: be permissive and let the API
  // surface a clear error. The provider also has its own `S2V-01`
  // special-case, so this branch is only hit for unknowns.
  return ["768P", "1080P"];
}

/** Snap an requested duration to a value the model actually supports.
 *  Hailuo only supports 6s and 10s; I2V-01 only supports 6s. */
export function normalizeMiniMaxDuration(
  model: string,
  duration: number,
): number {
  if (isHailuoFamily(model)) {
    // Hailuo supports 6s and 10s. Round shorter requests to 6s, longer
    // requests to 10s so the API never receives an unsupported duration.
    return duration <= 7 ? 6 : 10;
  }
  if (isI2V01Family(model)) {
    return 6;
  }
  return duration;
}

/** Default resolution for a model+duration.  Matches the docs' stated
 *  default (`768P` for Hailuo, `720P` for I2V-01 family). */
export function defaultResolutionFor(
  model: string,
  duration: number,
): string {
  if (isHailuoFamily(model)) {
    // Hailuo-02 I2V also accepts 512P, but docs still mark 768P as the
    // default ("768P (默认)" in the resolution table). Stay with 768P
    // unless/until docs change.
    if (HAILUO_RESOLUTION_TABLE[duration]?.includes("768P")) return "768P";
    return HAILUO_RESOLUTION_TABLE[duration]?.[0] ?? "768P";
  }
  if (isI2V01Family(model)) {
    return "720P";
  }
  return "768P";
}
