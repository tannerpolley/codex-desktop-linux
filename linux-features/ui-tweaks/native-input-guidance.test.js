#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EXPANDED_GUIDANCE,
  LEGACY_GUIDANCE,
  patchCodexRequestUserInputGuidance,
} = require("./patches/native-input-guidance.js");

test("replaces every legacy native-input limit hint without changing the executable size", () => {
  const source = Buffer.from(`prefix\0${LEGACY_GUIDANCE.join("\0")}\0suffix`);
  const patched = patchCodexRequestUserInputGuidance(source);

  assert.equal(patched.length, source.length);
  for (const value of LEGACY_GUIDANCE) assert.equal(patched.includes(value), false);
  for (const value of EXPANDED_GUIDANCE) assert.equal(patched.includes(value), true);
  assert.deepEqual(patchCodexRequestUserInputGuidance(patched), patched);
});

test("rejects partial or drifted Codex guidance instead of producing a mixed schema", () => {
  const incomplete = Buffer.from(`${LEGACY_GUIDANCE[0]}\0${LEGACY_GUIDANCE[1]}`);
  assert.throws(
    () => patchCodexRequestUserInputGuidance(incomplete),
    /expected all legacy guidance strings exactly once/u,
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
  fs.writeFileSync(executable, Buffer.from(`prefix\0${LEGACY_GUIDANCE.join("\0")}\0suffix`), { mode: 0o755 });
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
    assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
