#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
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
