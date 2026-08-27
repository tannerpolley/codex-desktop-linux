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

function patchCodexRequestUserInputGuidance(source) {
  if (!Buffer.isBuffer(source)) throw new TypeError("Codex executable must be a Buffer");
  const legacyCounts = LEGACY_GUIDANCE.map((value) => occurrences(source, value));
  const expandedCounts = EXPANDED_GUIDANCE.map((value) => occurrences(source, value));
  if (legacyCounts.every((count) => count === 0) && expandedCounts.every((count) => count === 1)) {
    return source;
  }
  if (!legacyCounts.every((count) => count === 1) || !expandedCounts.every((count) => count === 0)) {
    throw new Error("expected all legacy guidance strings exactly once in the Codex executable");
  }
  const output = Buffer.from(source);
  LEGACY_GUIDANCE.forEach((legacy, index) => {
    const replacement = Buffer.from(EXPANDED_GUIDANCE[index]);
    const needle = Buffer.from(legacy);
    if (needle.length !== replacement.length) throw new Error("native-input replacement must preserve executable size");
    replacement.copy(output, output.indexOf(needle));
  });
  return output;
}

function patchExecutable(file) {
  const source = fs.readFileSync(file);
  const output = patchCodexRequestUserInputGuidance(source);
  if (output === source) return false;
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
  EXPANDED_GUIDANCE,
  LEGACY_GUIDANCE,
  enabled,
  patchCodexRequestUserInputGuidance,
  patchExecutable,
};
