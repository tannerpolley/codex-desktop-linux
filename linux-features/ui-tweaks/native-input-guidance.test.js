#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_GUIDANCE,
  DEFAULT_REPLACEMENTS,
  EXPANDED_GUIDANCE,
  LEGACY_GUIDANCE,
  patchExecutable,
  patchCodexRequestUserInputGuidance,
} = require("./patches/native-input-guidance.js");

const EXPECTED_POLICY = [
  "Use native input for every user-facing question when callable and representable",
  "no answer keeps decisions pending",
  "no authorization",
  "without count or option limits",
  "without a plain-text substitute",
];

function completeSource() {
  return Buffer.from(
    `prefix\n\n${DEFAULT_GUIDANCE.join("\n\n")}\0prefix\\n\\n${DEFAULT_GUIDANCE.join("\\n\\n")}\0${LEGACY_GUIDANCE.join("\0")}`,
  );
}

test("replaces both compiled Default-mode guidance representations", () => {
  const source = completeSource();
  const patched = patchCodexRequestUserInputGuidance(source);

  assert.equal(patched.length, source.length);
  for (const value of DEFAULT_GUIDANCE) assert.equal(patched.includes(value), false);
  for (const value of DEFAULT_REPLACEMENTS.flat()) {
    assert.equal(patched.toString().split(value).length - 1, 1);
  }
  for (const value of EXPECTED_POLICY) assert.match(patched.toString(), new RegExp(value));
  assert.deepEqual(patchCodexRequestUserInputGuidance(patched), patched);
});

test("replaces every legacy native-input limit hint without changing the executable size", () => {
  const source = completeSource();
  const patched = patchCodexRequestUserInputGuidance(source);

  assert.equal(patched.length, source.length);
  for (const value of LEGACY_GUIDANCE) assert.equal(patched.includes(value), false);
  for (const value of EXPANDED_GUIDANCE) assert.equal(patched.includes(value), true);
  assert.deepEqual(patchCodexRequestUserInputGuidance(patched), patched);
});

test("rejects partial or drifted Codex guidance instead of producing a mixed schema", () => {
  const incomplete = completeSource();
  const legacyOnly = Buffer.from(`prefix\0${LEGACY_GUIDANCE.join("\0")}\0suffix`);
  const defaultOnly = Buffer.from(`${DEFAULT_GUIDANCE.join("\n\n")}\0prefix\\n\\n${DEFAULT_GUIDANCE.join("\\n\\n")}`);
  assert.throws(
    () => patchCodexRequestUserInputGuidance(Buffer.from(`${incomplete.toString()}\0${LEGACY_GUIDANCE[0]}`)),
    /guidance contract/u,
  );
  assert.throws(() => patchCodexRequestUserInputGuidance(legacyOnly), /guidance representation/u);
  assert.throws(() => patchCodexRequestUserInputGuidance(defaultOnly), /guidance contract/u);
});

test("rejects partial, duplicate, mixed, and drifted Default-mode contracts", () => {
  const complete = completeSource().toString();
  const cases = [
    complete.replace(DEFAULT_GUIDANCE[0], "drifted guidance"),
    `${complete}\0${DEFAULT_GUIDANCE[0]}`,
    complete.replace(DEFAULT_GUIDANCE[0], DEFAULT_REPLACEMENTS[0][0]),
    complete.replace(DEFAULT_GUIDANCE[0], `${DEFAULT_GUIDANCE[0].slice(0, -1)}x`),
    complete.replace("\n\n" + DEFAULT_GUIDANCE[1], "\\n" + DEFAULT_GUIDANCE[1]),
    complete.replace("\n\n" + DEFAULT_GUIDANCE[1], "\n\n\n" + DEFAULT_GUIDANCE[1]),
    complete.replace("\\n\\n" + DEFAULT_GUIDANCE[1], "\\n\\n\\n" + DEFAULT_GUIDANCE[1]),
    complete.replace("\n\n" + DEFAULT_GUIDANCE[1], "\n\ninserted\n\n" + DEFAULT_GUIDANCE[1]),
  ];
  for (const value of cases) assert.throws(
    () => patchCodexRequestUserInputGuidance(Buffer.from(value)),
    /guidance representation|guidance contract/u,
  );
});

test("the UI Tweaks stage hook patches the installed Codex executable when enabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-input-guidance-"));
  const upstream = path.join(root, "upstream");
  const install = path.join(root, "install");
  const executable = path.join(install, "resources", "codex");
  const config = path.join(root, "features.json");
  fs.mkdirSync(upstream, { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, completeSource(), { mode: 0o755 });
  fs.writeFileSync(config, JSON.stringify({
    enabled: ["ui-tweaks"],
    settings: {
      "ui-tweaks": {
        tweaks: { composer: { expandedNativeInputChoices: { enabled: true } } },
      },
    },
  }));
  try {
    const result = spawnSync("bash", [path.join(__dirname, "stage.sh")], {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_LINUX_FEATURES_CONFIG: config,
        CODEX_UPSTREAM_APP_DIR: upstream,
        INSTALL_DIR: install,
        SCRIPT_DIR: path.resolve(__dirname, "../.."),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const patched = fs.readFileSync(executable);
    for (const value of LEGACY_GUIDANCE) assert.equal(patched.includes(value), false);
    for (const value of EXPANDED_GUIDANCE) assert.equal(patched.includes(value), true);
    for (const value of DEFAULT_GUIDANCE) assert.equal(patched.includes(value), false);
    for (const value of DEFAULT_REPLACEMENTS.flat()) assert.equal(patched.toString().split(value).length - 1, 1);
    assert.equal(patchExecutable(executable), false);
    assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
