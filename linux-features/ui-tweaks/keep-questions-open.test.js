#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const featureManifest = require("./feature.json");
const {
  RUNTIME_MARKER,
  SETTINGS_MARKER,
  applyKeepQuestionsOpenAppPatch,
  applyKeepQuestionsOpenPatch,
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
  const source = appInitialFixture();
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

test("keeps structured questions open and removes both Snooze surfaces", () => {
  const patched = applyKeepQuestionsOpenPatch(appInitialFixture(), enabledContext());
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.match(patched, /sw\(`codex-linux-disable-request-user-input-auto-resolution`\)\?\.data!==!1/);
  assert.match(patched, /requestUserInputAutoResolution\.snooze/);
  assert.match(patched, /!codexLinuxKeepQuestionsOpen&&_\?\.resolutionState\.status===`scheduled`/);
  assert.match(patched, /!codexLinuxKeepQuestionsOpen&&_!=null&&_\.resolutionState\.status!==`snoozed`/);
  assert.match(patched, /!codexLinuxKeepQuestionsOpen&&wt\?\.resolutionState\.status===`scheduled`/);
  assert.equal(applyKeepQuestionsOpenPatch(patched, enabledContext()), patched);
});

test("adds all Linux revision settings and patches extracted assets atomically", () => {
  const fixture = createExtractedApp();
  try {
    const result = applyKeepQuestionsOpenAppPatch(fixture.extractedDir, enabledContext());
    assert.equal(result.matched, 2, JSON.stringify(result));
    assert.equal(result.changed, 2);
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
      matched: 2,
      changed: 0,
      reason: null,
      targets: ["app-initial-fixture.js", "general-settings-fixture.js"],
    });
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});

test("reuses the settings chunk's existing host-request import", () => {
  const fixture = createExtractedApp();
  try {
    const result = applyKeepQuestionsOpenAppPatch(fixture.extractedDir, enabledContext());
    assert.equal(result.matched, 2, JSON.stringify(result));
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
  const appName = fs.readdirSync(assetsDir).find((name) => /^app-initial-.*\.js$/.test(name));
  const settingsName = fs.readdirSync(assetsDir).find((name) => /^general-settings-.*\.js$/.test(name) && fs.readFileSync(path.join(assetsDir, name), "utf8").includes("slug:`general-settings`"));
  assert.ok(appName);
  assert.ok(settingsName);
  const fixture = createExtractedApp(
    fs.readFileSync(path.join(assetsDir, appName), "utf8"),
    fs.readFileSync(path.join(assetsDir, settingsName), "utf8"),
    appName,
    settingsName,
  );
  try {
    const result = applyKeepQuestionsOpenAppPatch(fixture.extractedDir, enabledContext());
    assert.equal(result.matched, 2, JSON.stringify(result));
    assert.equal(result.changed, 2);
    const appPath = path.join(fixture.assetsDir, appName);
    const settingsPath = path.join(fixture.assetsDir, settingsName);
    const app = fs.readFileSync(appPath, "utf8");
    assert.match(app, /!codexLinuxKeepQuestionsOpen&&_\?\.resolutionState\.status===`scheduled`/);
    assert.match(app, /!codexLinuxKeepQuestionsOpen&&Pt\?\.resolutionState\.status===`scheduled`/);
    assert.match(fs.readFileSync(settingsPath, "utf8"), new RegExp(SETTINGS_MARKER));
    for (const target of [appPath, settingsPath]) {
      const syntax = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});
