#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LEGACY_GUIDANCE = [
  "Request user input for one to three short questions and wait for the response.",
  "Provide 2-3 mutually exclusive choices.",
  "Questions to show the user. Prefer 1 and do not exceed 3",
];
const EXPANDED_GUIDANCE = [
  "Request user input for all useful short questions and wait for the response.  ",
  "Provide all mutually exclusive choices.",
  "Questions to show the user. Include all useful questions",
];
const DEFAULT_GUIDANCE = [
  "Use the `request_user_input` tool only for optional questions where the answer would materially improve the quality of the work.",
  "If `request_user_input` returns no answers, continue with best judgment instead of asking again or treating the turn as blocked.",
  "Never use the `request_user_input` tool for permission requests or permission-related escalations.",
  "If explicit user input is required for another reason before progress can safely continue, do not use the `request_user_input` tool. Ask the user directly with one concise plain-text question instead. Never write a multiple choice question as a textual assistant message.",
];
const DEFAULT_REPLACEMENTS = [
  [
    "Use native input for every user-facing question when callable and representable; infer only routine reversible details.",
    "Use native input for every representable user-facing question; infer only routine reversible details.",
  ],
  [
    "Await material answers; no answer keeps decisions pending, with no authorization or async continuation.",
    "Wait for material answers; no answer keeps decisions pending, grants no authorization, and forbids async continuation.",
  ],
  [
    "Use native input for representable permission questions; wait for the answer.",
    "Ask representable permission questions natively; wait for an answer.",
  ],
  [
    "Use native input for complete question sets without count or option limits; if unavailable or unrepresentable, report the limitation without a plain-text substitute.",
    "Use complete native question sets without count or option limits; report unavailable or unrepresentable input without a plain-text substitute.",
  ],
].map((values, index) => values.map((value) => value.padEnd(DEFAULT_GUIDANCE[index].length)));
const DEFAULT_BLOCKS = [
  DEFAULT_GUIDANCE.join("\n\n"),
  DEFAULT_GUIDANCE.join("\\n\\n"),
];
const DEFAULT_REPLACEMENT_BLOCKS = [
  DEFAULT_REPLACEMENTS.map(([literal]) => literal).join("\n\n"),
  DEFAULT_REPLACEMENTS.map(([, escaped]) => escaped).join("\\n\\n"),
];

function enabled(context) {
  const defaults = context?.feature?.manifest?.tweaks?.composer?.expandedNativeInputChoices;
  const settings = context?.feature?.settings?.tweaks?.composer?.expandedNativeInputChoices;
  return (settings?.enabled ?? defaults?.enabled) === true;
}

function occurrences(buffer, value) {
  const needle = Buffer.from(value);
  let count = 0;
  let offset = 0;
  while ((offset = buffer.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function patchSimpleContract(output, oldValues, replacements) {
  const oldCounts = oldValues.map((value) => occurrences(output, value));
  const replacementCounts = replacements.map((value) => occurrences(output, value));
  if (oldCounts.every((count) => count === 0) && replacementCounts.every((count) => count === 1)) return;
  if (!oldCounts.every((count) => count === 1) || !replacementCounts.every((count) => count === 0)) {
    throw new Error("expected one complete native-input guidance contract in the Codex executable");
  }
  oldValues.forEach((oldValue, index) => {
    const replacement = Buffer.from(replacements[index]);
    const needle = Buffer.from(oldValue);
    if (needle.length !== replacement.length) throw new Error("native-input replacement must preserve executable size");
    let offset = 0;
    while ((offset = output.indexOf(needle, offset)) !== -1) {
      replacement.copy(output, offset);
      offset += replacement.length;
    }
  });
}

function patchDefaultContract(output) {
  const oldCounts = DEFAULT_BLOCKS.map((value) => occurrences(output, value));
  const replacementCounts = DEFAULT_REPLACEMENT_BLOCKS.map((value) => occurrences(output, value));
  const oldInstructionCounts = DEFAULT_GUIDANCE.map((value) => occurrences(output, value));
  const replacementInstructionCounts = DEFAULT_REPLACEMENTS.flat().map((value) => occurrences(output, value));
  if (oldCounts.every((count) => count === 0) &&
      replacementCounts.every((count) => count === 1) &&
      oldInstructionCounts.every((count) => count === 0) &&
      replacementInstructionCounts.every((count) => count === 1)) return;
  if (!oldCounts.every((count) => count === 1) ||
      !replacementCounts.every((count) => count === 0) ||
      !oldInstructionCounts.every((count) => count === 2) ||
      !replacementInstructionCounts.every((count) => count === 0)) {
    throw new Error("expected one literal-newline and one escaped-newline guidance representation");
  }
  DEFAULT_BLOCKS.forEach((block, index) => {
    const replacement = Buffer.from(DEFAULT_REPLACEMENT_BLOCKS[index]);
    const needle = Buffer.from(block);
    if (needle.length !== replacement.length) throw new Error("native-input replacement must preserve executable size");
    replacement.copy(output, output.indexOf(needle));
  });
}

function patchCodexRequestUserInputGuidance(source) {
  if (!Buffer.isBuffer(source)) throw new TypeError("Codex executable must be a Buffer");
  const output = Buffer.from(source);
  patchSimpleContract(output, LEGACY_GUIDANCE, EXPANDED_GUIDANCE);
  patchDefaultContract(output);
  return output;
}

function patchExecutable(file) {
  const source = fs.readFileSync(file);
  const output = patchCodexRequestUserInputGuidance(source);
  if (output.equals(source)) return false;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, output, { mode: fs.statSync(file).mode });
  fs.renameSync(temporary, file);
  return true;
}

if (require.main === module) {
  const file = process.argv[2];
  if (file == null) {
    console.error("Usage: native-input-guidance.js <codex-executable>");
    process.exit(2);
  }
  patchExecutable(file);
}

module.exports = {
  DEFAULT_GUIDANCE,
  DEFAULT_REPLACEMENTS,
  EXPANDED_GUIDANCE,
  LEGACY_GUIDANCE,
  enabled,
  patchCodexRequestUserInputGuidance,
  patchExecutable,
};
