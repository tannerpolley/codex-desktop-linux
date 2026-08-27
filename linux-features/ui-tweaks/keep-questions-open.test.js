#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const featureManifest = require("./feature.json");
const {
  RUNTIME_MARKER,
  SETTINGS_MARKER,
  applyKeepQuestionsOpenAppPatch,
  applyKeepQuestionsOpenPatch,
  applyKeepQuestionsOpenRuntimePatch,
  descriptors,
} = require("./patches/keep-questions-open.js");

function enabledContext() {
  return {
    feature: {
      manifest: featureManifest,
      settings: { tweaks: { composer: { keepQuestionsOpen: { enabled: true } } } },
    },
  };
}

function appInitialFixture() {
  return [
    "var op,ert,sp=e((()=>{op=$f(Q,`get-global-state`,e=>({params:{key:e}})),ert=Aa(Q,(e,{get:t})=>t(op,e))}));function sw(e){return cs(ert,e)};",
    "function RGc(e){let{conversationId:n,forceOtherOption:r,hostId:i,request:a,replyWithEmptyResponseOnDismiss:o}=e,g=Fo(FQ,{conversationId:n,hostId:i}),_=g?.requestId===a.requestId?g:null,v=_?.resolutionState.status===`scheduled`?_.resolutionState:null,k=_!=null&&_.resolutionState.status!==`snoozed`?()=>RX.requestUserInputAutoResolution.snooze({conversationId:n,hostId:i,requestId:a.requestId}):void 0;void `reply-with-user-input-response`;void `interrupt-conversation`;return{autoResolution:v,onUserInteraction:k}}var DHs,XGc,MHs=e((()=>{DHs=c(),XGc=t(F(),1)}));",
    "function cjl(e){let wt=e.pending,Ft=wt?.resolutionState.status===`scheduled`?wt.resolutionState:null,It=wt?.resolutionState.status===`scheduled`?wt.requestId:null,Lt={ariaLabel:Ft==null?void 0:dBl.snoozeInputTimeout,onClick:It==null?void 0:()=>RX.requestUserInputAutoResolution.snooze({requestId:It}),progress:Ft==null?void 0:{deadlineMs:Ft.deadlineMs}};return Lt}",
    "async function request(...e){let[t,n]=e,{params:r,source:i}=n;return send(t,r,i)};export{request as $Pt};void `vscode://codex/`;",
  ].join("");
}

function mainBundleFixture() {
  return "globalThis.AutoResolution=class{tracked=[];removed=[];observeServerRequest(e){if(e.method===`item/tool/requestUserInput`){let t=e.params.threadId;if(e.params.isBlocking===!0){this.removePendingRequest(t);return}this.trackRequest(t,e.id,`empty-user-input`);return}if(e.method===`mcpServer/elicitation/request`)this.trackRequest(e.params.threadId,e.id,`decline-mcp-elicitation`)}trackRequest(...e){this.tracked.push(e)}removePendingRequest(e){this.removed.push(e)}}";
}

function generalSettingsFixture() {
  return [
    'import{$Pt as rq}from"./app-initial-fixture.js";',
    "function ha(){let n=(0,$.jsx)(Ht,{slug:`general-settings`});return n}",
    "function ga(){let l=null,T=(0,$.jsxs)(R,{children:[u,(0,$.jsx)(R.Content,{children:(0,$.jsxs)(S,{children:[d]})})]}),E=null,O=null,A=null,j=(0,$.jsxs)($.Fragment,{children:[l,T,E,O,A]});return j}",
    "function row(){return(0,$.jsx)(H,{label:l,control:(0,$.jsx)(bn,{checked:e,onChange:a,ariaLabel:o})})}",
    "var ro=t(F(),1);export{ha as i};",
  ].join("");
}

function createExtractedApp(
  appSource = appInitialFixture(),
  settingsSource = generalSettingsFixture(),
  appName = "app-initial-fixture.js",
  settingsName = "general-settings-fixture.js",
) {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-questions-open-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, appName), appSource);
  fs.writeFileSync(path.join(assetsDir, settingsName), settingsSource);
  return { extractedDir, assetsDir };
}

test("keep questions open is independently disabled by default", () => {
  const source = mainBundleFixture();
  assert.equal(featureManifest.tweaks.composer.keepQuestionsOpen.enabled, false);
  assert.equal(applyKeepQuestionsOpenPatch(source, { feature: { manifest: featureManifest } }), source);
  const fixture = createExtractedApp();
  try {
    const result = applyKeepQuestionsOpenAppPatch(fixture.extractedDir, { feature: { manifest: featureManifest } });
    assert.equal(result.matched, 1);
    assert.deepEqual(result.targets, ["general-settings-fixture.js"]);
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});

test("removes the empty-answer timer without changing explicit response handling", () => {
  const patched = applyKeepQuestionsOpenPatch(mainBundleFixture(), enabledContext());
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.doesNotMatch(patched, /`empty-user-input`/);
  assert.doesNotMatch(patched, /requestUserInputAutoResolution\.snooze/);
  assert.match(patched, /this\.removePendingRequest\(t\)/);
  assert.match(patched, /`decline-mcp-elicitation`/);

  const context = {};
  vm.runInNewContext(patched, context);
  const scheduler = new context.AutoResolution();
  scheduler.observeServerRequest({ method: "item/tool/requestUserInput", id: 1, params: { threadId: "thread-a" } });
  assert.deepEqual(Array.from(scheduler.removed), ["thread-a"]);
  assert.deepEqual(Array.from(scheduler.tracked), []);
  scheduler.observeServerRequest({ method: "mcpServer/elicitation/request", id: 2, params: { threadId: "thread-b" } });
  assert.deepEqual(Array.from(scheduler.tracked, (entry) => Array.from(entry)), [["thread-b", 2, "decline-mcp-elicitation"]]);
  assert.match(appInitialFixture(), /reply-with-user-input-response/);
  assert.equal(applyKeepQuestionsOpenPatch(patched, enabledContext()), patched);

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-questions-runtime-"));
  const buildDir = path.join(runtimeDir, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "src-fixture.js"), mainBundleFixture());
  try {
    assert.deepEqual(applyKeepQuestionsOpenRuntimePatch(runtimeDir, enabledContext()), {
      matched: 1,
      changed: 1,
      reason: null,
      targets: ["src-fixture.js"],
    });
    assert.deepEqual(applyKeepQuestionsOpenRuntimePatch(runtimeDir, enabledContext()), {
      matched: 1,
      changed: 0,
      reason: null,
      targets: ["src-fixture.js"],
    });
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("adds all Linux revision settings and patches extracted assets atomically", () => {
  const fixture = createExtractedApp();
  try {
    const result = applyKeepQuestionsOpenAppPatch(fixture.extractedDir, enabledContext());
    assert.equal(result.matched, 1, JSON.stringify(result));
    assert.equal(result.changed, 1);
    const settings = fs.readFileSync(path.join(fixture.assetsDir, "general-settings-fixture.js"), "utf8");
    assert.match(settings, new RegExp(SETTINGS_MARKER));
    assert.match(settings, /Linux revisions/);
    assert.match(settings, /Keep questions open/);
    assert.match(settings, /Order skill mentions/);
    assert.match(settings, /Dock icon controls/);
    assert.match(settings, /Extended UI font size/);
    assert.match(settings, /Suggested prompts/);
    assert.match(settings, /Show models by default/);
    assert.match(settings, /English reasoning labels/);
    assert.match(settings, /Emphasize project names/);
    assert.match(settings, /Apply and rebuild/);
    assert.match(settings, /linuxRevisions/);
    assert.match(settings, /get-global-state/);
    assert.match(settings, /set-global-state/);
    assert.match(settings, /codex-linux-disable-request-user-input-auto-resolution/);
    assert.deepEqual(applyKeepQuestionsOpenAppPatch(fixture.extractedDir, enabledContext()), {
      matched: 1,
      changed: 0,
      reason: null,
      targets: ["general-settings-fixture.js"],
    });
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});

test("reuses the settings chunk's existing host-request import", () => {
  const fixture = createExtractedApp();
  try {
    const result = applyKeepQuestionsOpenAppPatch(fixture.extractedDir, enabledContext());
    assert.equal(result.matched, 1, JSON.stringify(result));
    const settings = fs.readFileSync(path.join(fixture.assetsDir, "general-settings-fixture.js"), "utf8");
    assert.doesNotMatch(settings, /import\("\.\/app-initial-fixture\.js"\)/);
    assert.match(settings, /rq\(`get-global-state`/);
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});

test("matches the current signed official bundle when provided", { skip: process.env.CODEX_OFFICIAL_EXTRACTED_DIR == null }, () => {
  const sourceDir = process.env.CODEX_OFFICIAL_EXTRACTED_DIR;
  const assetsDir = path.join(sourceDir, "webview", "assets");
  const buildDir = path.join(sourceDir, ".vite", "build");
  const mainName = fs.readdirSync(buildDir).find((name) => name.endsWith(".js") && /this\.trackRequest\([^;]{0,300},`empty-user-input`\)/u.test(fs.readFileSync(path.join(buildDir, name), "utf8")));
  const appName = fs.readdirSync(assetsDir).find((name) => /^app-initial-.*\.js$/.test(name));
  const settingsName = fs.readdirSync(assetsDir).find((name) => /^general-settings-.*\.js$/.test(name) && fs.readFileSync(path.join(assetsDir, name), "utf8").includes("slug:`general-settings`"));
  assert.ok(mainName);
  assert.ok(appName);
  assert.ok(settingsName);
  const fixture = createExtractedApp(
    fs.readFileSync(path.join(assetsDir, appName), "utf8"),
    fs.readFileSync(path.join(assetsDir, settingsName), "utf8"),
    appName,
    settingsName,
  );
  try {
    const fixtureBuildDir = path.join(fixture.extractedDir, ".vite", "build");
    fs.mkdirSync(fixtureBuildDir, { recursive: true });
    const mainPath = path.join(fixtureBuildDir, mainName);
    fs.copyFileSync(path.join(buildDir, mainName), mainPath);
    assert.deepEqual(applyKeepQuestionsOpenRuntimePatch(fixture.extractedDir, enabledContext()), {
      matched: 1,
      changed: 1,
      reason: null,
      targets: [mainName],
    });
    const main = fs.readFileSync(mainPath, "utf8");
    assert.match(main, new RegExp(RUNTIME_MARKER));
    assert.doesNotMatch(main, /this\.trackRequest\([^;]*,`empty-user-input`\)/u);
    const result = applyKeepQuestionsOpenAppPatch(fixture.extractedDir, enabledContext());
    assert.equal(result.matched, 1, JSON.stringify(result));
    assert.equal(result.changed, 1);
    const appPath = path.join(fixture.assetsDir, appName);
    const settingsPath = path.join(fixture.assetsDir, settingsName);
    const app = fs.readFileSync(appPath, "utf8");
    assert.equal(app, fs.readFileSync(path.join(assetsDir, appName), "utf8"));
    assert.match(app, /replyWithUserInputResponse/);
    assert.match(fs.readFileSync(settingsPath, "utf8"), new RegExp(SETTINGS_MARKER));
    for (const target of [mainPath, appPath, settingsPath]) {
      const syntax = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});
