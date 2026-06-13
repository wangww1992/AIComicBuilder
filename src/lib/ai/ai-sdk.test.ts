// @ts-nocheck — test file uses Node 22 `--experimental-strip-types`, which
// requires the `.ts` extension in relative imports. The project's tsc
// build is not expected to type-check this file.
/**
 * Tests for `extractJSON` — the central helper that turns raw LLM output
 * into a JSON-parseable string. Run with:
 *   node --experimental-strip-types --test src/lib/ai/ai-sdk.test.ts
 *
 * Background: bug report — 角色提取 fails with
 *   `Unexpected token '<', "<think>Let"... is not valid JSON`
 * because Qwen3 / DeepSeek-R1 / GLM-4 etc. emit `<think>...</think>`
 * reasoning blocks BEFORE the JSON, and the current extractor only
 * strips ```json fences. These tests pin down the fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJSON, stripThinking } from "./ai-sdk.ts";

const char = (name: string) =>
  JSON.stringify({ name, frequency: 1, description: "x", visualHint: "x" });

test("pure JSON object passes through", () => {
  const text = `{"characters": [${char("Alice")}], "relationships": []}`;
  assert.equal(JSON.parse(extractJSON(text)).characters[0].name, "Alice");
});

test("JSON inside a ```json fence is unwrapped", () => {
  const text = "```json\n" + `{"characters": [${char("Alice")}]}` + "\n```";
  assert.equal(JSON.parse(extractJSON(text)).characters[0].name, "Alice");
});

test("JSON inside a bare ``` fence is unwrapped", () => {
  const text = "```\n" + `{"characters": [${char("Alice")}]}` + "\n```";
  assert.equal(JSON.parse(extractJSON(text)).characters[0].name, "Alice");
});

// Regression: the bug the user hit
test("REGRESSION: <think>...</think> block is stripped before parse (Qwen3 / GLM-4)", () => {
  const text =
    "<think>Let me analyze the text and find the characters.\n" +
    "I see Alice and Bob. I will output JSON now.</think>\n" +
    `{"characters": [${char("Alice")}, ${char("Bob")}], "relationships": []}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters.length, 2);
  assert.equal(parsed.characters[0].name, "Alice");
});

test("DeepSeek-R1 special-token think block is stripped", () => {
  const text =
    "<|begin▁of▁think|>Let me think about this carefully.<|end▁of▁think|>\n" +
    `{"characters": [${char("Alice")}]}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

test("DeepSeek-R1 with underscore begin/end markers is stripped", () => {
  const text =
    "<|begin_of_think|>reasoning<|end_of_think|>\n" +
    `{"characters": [${char("Alice")}]}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

test("multiple <think> blocks in one response are all stripped", () => {
  const text =
    "<think>first thought</think>Some prose in between.<think>second thought</think>\n" +
    `{"characters": [${char("Alice")}]}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

// Prose-around-JSON cases (no fence, no think tag)
test("prose preamble + raw JSON object: the JSON is extracted", () => {
  const text =
    "Sure, here is the JSON you asked for:\n" +
    `{"characters": [${char("Alice")}]}\n` +
    "Let me know if you need anything else.";
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

test("prose preamble + raw JSON array: the array is extracted", () => {
  const text = `Here are the characters:\n[${char("Alice")}, ${char("Bob")}]\nDone.`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.length, 2);
});

// Sanity: already-clean inputs are unchanged
test("array input is returned verbatim when clean", () => {
  const text = `[${char("Alice")}, ${char("Bob")}]`;
  assert.deepEqual(JSON.parse(extractJSON(text)), JSON.parse(text));
});

test("object input is returned verbatim when clean", () => {
  const text = `{"characters": [${char("Alice")}]}`;
  assert.deepEqual(JSON.parse(extractJSON(text)), JSON.parse(text));
});

// Robustness: a real NUL control char between two letters of a name is stripped
test("real NUL control char in text is removed", () => {
  // Build the input by concatenation so the NUL stays as a real char
  // instead of being JSON-escaped away by JSON.stringify.
  const text = `{"characters":[{"name":"Ali${"\x00"}ce"}]}`;
  const parsed = JSON.parse(extractJSON(text));
  assert.equal(parsed.characters[0].name, "Alice");
});

// ── stripThinking: the plain-text counterpart of extractJSON ──────────
// Used for streaming text output (script_outline, script_generate, ...)
// where we want the model's chain-of-thought hidden from the user / DB.

test("stripThinking: removes a single <think> block (Qwen3 / GLM-4)", () => {
  const text = "<think>The user wants a story about Alice and Bob.</think>" +
    "Alice went to the market. Bob stayed home.";
  assert.equal(
    stripThinking(text),
    "Alice went to the market. Bob stayed home."
  );
});

test("stripThinking: removes DeepSeek-R1 unicode think markers", () => {
  const text =
    "<|begin▁of▁think|>let me think<|end▁of▁think|>\nThe answer is 42.";
  // The leading newline after the think block is preserved — trimming
  // is the caller's job.
  assert.equal(stripThinking(text), "\nThe answer is 42.");
});

test("stripThinking: removes DeepSeek-R1 underscore think markers", () => {
  const text = "<|begin_of_think|>reasoning<|end_of_think|>\nFinal answer.";
  // The leading newline after the think block is preserved — trimming
  // is the caller's job (it varies whether the model leaves one).
  assert.equal(stripThinking(text), "\nFinal answer.");
});

test("stripThinking: removes multiple <think> blocks in one response", () => {
  const text =
    "<think>first thought</think>Hello, <think>second thought</think>world.";
  assert.equal(stripThinking(text), "Hello, world.");
});

test("stripThinking: leaves plain text untouched", () => {
  const text = "Just a normal story about Alice and Bob. No thinking here.";
  assert.equal(stripThinking(text), text);
});

test("stripThinking: collapses extra blank lines left behind", () => {
  // After stripping a block, multiple consecutive newlines can pile up.
  // We do NOT trim/collapse here — that's the caller's job — but we
  // verify the helper leaves predictable whitespace.
  const text = "<think>thought</think>\n\n\nReal text.";
  assert.equal(stripThinking(text), "\n\n\nReal text.");
});
