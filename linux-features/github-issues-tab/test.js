#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const manifest = require("./feature.json");
const { authEntries, buildSearchQuery, normalizeIssue } = require("./issues-adapter.js");
const { applyMainBridgePatch, applyPreloadBridgePatch } = require("./bridge-source.js");
const { ROUTE_MARKER, patchRouteAndSidebar, stageRenderer } = require("./patch.js");

function assertModuleSyntax(filePath) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", "-e",
    "new (require('node:vm').SourceTextModule)(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
    filePath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("feature is optional and stages only its runtime resources", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.resources.map(({ source }) => source), ["issues-adapter.js", "protocol.js"]);
  assertModuleSyntax(path.join(__dirname, "renderer.mjs"));
});

test("account-wide search never requires a repository", () => {
  assert.equal(buildSearchQuery({ view: "all", state: "open", repository: null, query: "label:bug" }, "octocat"), "is:issue is:open involves:octocat label:bug sort:updated-desc");
  assert.equal(buildSearchQuery({ view: "assigned", state: "all", repository: "openai/codex", query: "" }, "octocat"), "is:issue assignee:octocat repo:openai/codex sort:updated-desc");
  assert.deepEqual(authEntries({ hosts: { "github.com": [{ active: true, state: "success", login: "octocat" }] } }), [{ host: "github.com", login: "octocat" }]);
});

test("normalizes the list and detail fields used by the PR-shaped renderer", () => {
  const issue = normalizeIssue({ id: "I_1", number: 7, title: "Bug", url: "https://github.com/a/b/issues/7", state: "OPEN", repository: { nameWithOwner: "a/b" }, labels: { nodes: [{ name: "bug", color: "f00" }] }, assignees: { nodes: [{ login: "octocat" }] }, comments: { totalCount: 1, nodes: [{ id: "C_1", body: "hello", createdAt: "2026-01-01T00:00:00Z", author: { login: "hubot" } }] } });
  assert.equal(issue.repository, "a/b");
  assert.equal(issue.commentCount, 1);
  assert.equal(issue.comments[0].author, "hubot");
});

test("patches the route and inserts Issues immediately after Pull requests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issues-route-"));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  const source = "var React,Pull;React=t(F(),1),Pull=lazy(()=>import(`./pull.js`).then(e=>({default:e.PullRequestsRoute})));const routes=(0,J.jsx)(Route,{path:`/pull-requests`,element:(0,J.jsx)(React.Suspense,{children:(0,J.jsx)(Pull,{})})});function nav(){let k=[],s=`/`,a=e=>e;k.push({id:N.pullRequests,label:(0,J.jsx)(T,{id:`sidebarElectron.pullRequestsRouteNavLink`,defaultMessage:`Pull requests`}),icon:Icon,visibleByDefault:!0,onSelect:()=>{open(store,a)},isCurrentDestination:s.startsWith(`/pull-requests`),hasUnreadActivity:!1});return k}";
  const target = path.join(assets, "app.js");
  fs.writeFileSync(target, source);
  try {
    const result = patchRouteAndSidebar(root);
    assert.equal(result.matched, true, JSON.stringify(result));
    const output = fs.readFileSync(target, "utf8");
    assert.match(output, new RegExp(ROUTE_MARKER));
    assert.match(output, /path:`\/issues`/);
    assert.match(output, /codexLinuxGithubIssuesRoute=lazy\(async\(\)=>\(await import\(`\/github-issues-tab\.mjs`\)\)\.createIssuesRoute\(\{React:React\}\)\)/);
    assert.doesNotMatch(output, /codexLinuxGithubIssuesRoute=lazy\(async\(\)=>\(\{default:/);
    const pull = output.indexOf("sidebarElectron.pullRequestsRouteNavLink");
    const issues = output.indexOf("codex-linux-github-issues");
    assert.ok(pull !== -1 && issues > pull);
    assert.match(output, /a\(`\/issues`\)/);
    assert.deepEqual(patchRouteAndSidebar(root), { matched: true, changed: 0, targets: ["app.js"] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stages renderer and patches trusted main and preload bridges", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issues-stage-"));
  fs.mkdirSync(path.join(root, "webview"), { recursive: true });
  try {
    assert.equal(stageRenderer(root).changed, 1);
    assert.equal(stageRenderer(root).changed, 0);
    const preload = "let e=require(`electron`),L={getSentryInitOptions:()=>w,send:x=>e.ipcRenderer.invoke(`x`,x)};e.contextBridge.exposeInMainWorld(`electronBridge`,L);";
    assert.match(applyPreloadBridgePatch(preload), /githubIssues:\{request:/);
    const main = "function register(e,t){return electron.ipcMain.handle(`message`,async(e,r)=>{if(!t(e))return;return r})}";
    const patchedMain = applyMainBridgePatch(main);
    assert.match(patchedMain, /codex-linux:github-issues/);
    assert.match(patchedMain, /resourcesPath,`cua_node`,`bin`,`node`/);
    assert.doesNotMatch(patchedMain, /resourcesPath,`node-runtime`/);
    assert.match(patchedMain, /`repository`,`query`,`cursor`/);
    assert.match(patchedMain, /codexLinuxGithubIssuesString\(input\.query,500,`query`,false\)/);
    assert.doesNotMatch(patchedMain, /codexLinuxGithubIssuesString\(input\.text/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
