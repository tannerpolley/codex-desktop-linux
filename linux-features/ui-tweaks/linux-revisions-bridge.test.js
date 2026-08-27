#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  CHANNEL,
  MAIN_MARKER,
  applyMainBridgePatch,
  applyPreloadBridgePatch,
  mainBridgeSource,
} = require("./patches/linux-revisions-bridge.js");
const { applyMainBridgePatch: applyIssuesMainBridgePatch } = require("../github-issues-tab/bridge-source.js");

test("adds the Linux revisions preload API once", () => {
  const source = "var j={send:e=>n.ipcRenderer.invoke(`send`,e),getSentryInitOptions:()=>y};n.contextBridge.exposeInMainWorld(`electronBridge`,j);";
  const patched = applyPreloadBridgePatch(source);
  assert.match(patched, new RegExp(`linuxRevisions:\\{request:request=>n\\.ipcRenderer\\.invoke\\(\\\`${CHANNEL}`));
  assert.equal(applyPreloadBridgePatch(patched), patched);
});

test("adds a trusted main-process handler once", () => {
  const source = "function register(isTrusted){return electron.ipcMain.handle(`message`,async(event,value)=>{if(!isTrusted(event))return;return value})}";
  const patched = applyMainBridgePatch(source);
  assert.match(patched, new RegExp(`${MAIN_MARKER}=1`));
  assert.match(patched, /rebuild-current/);
  assert.match(patched, /incomplete revision settings/);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(applyMainBridgePatch(patched), patched);
});

test("adds the revisions handler after the Issues bridge", () => {
  const source = "function register(isTrusted){return electron.ipcMain.handle(`message`,async(event,value)=>{if(!isTrusted(event))return;return value})}";
  const withIssues = applyIssuesMainBridgePatch(source);
  const patched = applyMainBridgePatch(withIssues);
  assert.match(patched, new RegExp(`${MAIN_MARKER}=1`));
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("generated main bridge allow-lists all eight revisions", () => {
  const source = mainBridgeSource("electron.ipcMain", "isTrusted");
  assert.equal((source.match(/keepQuestionsOpen/g) ?? []).length > 0, true);
  assert.equal((source.match(/projectName/g) ?? []).length > 0, true);
  assert.match(source, /features\.json/);
  assert.match(source, /codex-update-manager/);
  assert.doesNotThrow(() => new vm.Script(source));
});

test("generated main bridge reads the packaged revision settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linux-revisions-bridge-"));
  const resourcesPath = path.join(root, "app", "resources");
  const templatePath = path.join(root, "app", "update-builder", "linux-features", "features.json");
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(templatePath, JSON.stringify({
    enabled: ["ui-tweaks"],
    settings: { "ui-tweaks": { tweaks: { composer: { keepQuestionsOpen: { enabled: true } } } } },
  }));
  let handler;
  const context = {
    electron: { ipcMain: { handle: (_channel, value) => { handler = value; } } },
    globalThis: {},
    isTrusted: () => true,
    process: { env: { XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state") }, pid: 1, resourcesPath },
    require,
  };
  try {
    vm.runInNewContext(mainBridgeSource("electron.ipcMain", "isTrusted"), context);
    const result = await handler({}, { operation: "get" });
    assert.equal(result.tweaks["composer.keepQuestionsOpen"], true);
    assert.equal(result.status, "unavailable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
