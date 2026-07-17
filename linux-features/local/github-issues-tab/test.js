#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const featureDir = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(featureDir, "feature.json"), "utf8"));
const {
  OPERATIONS,
  VIEWS,
  STATES,
  LIMITS,
  validateEnvelope,
  validateResponse,
} = require("./protocol.js");
const {
  applyPreloadBridgePatch,
  applyMainBridgePatch,
  mainBridgeSource,
} = require("./bridge-source.js");
const { descriptors, patchPreloadBridgeAssets, optionalDriftStatus } = require("./patch.js");

const preloadDescriptor = descriptors.find((descriptor) => descriptor.id === "github-issues-preload-bridge");
const mainDescriptor = descriptors.find((descriptor) => descriptor.id === "github-issues-main-bridge");

test("local Issues feature stays disabled and stages only owned resources", () => {
  assert.equal(manifest.id, "github-issues-tab");
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.entrypoints, { patchDescriptors: "./patch.js" });
  assert.deepEqual(manifest.resources, [
    { source: "issues-adapter.js", target: ".codex-linux/features/github-issues-tab/issues-adapter.js", mode: "0644" },
    { source: "protocol.js", target: ".codex-linux/features/github-issues-tab/protocol.js", mode: "0644" },
    { source: "renderer.mjs", target: "content/webview/github-issues-tab.mjs", mode: "0644" },
  ]);
});

test("README documents local, disabled, authenticated, read-only operation", () => {
  const readme = fs.readFileSync(path.join(featureDir, "README.md"), "utf8");
  for (const phrase of ["current-DMG-only", "local/ignored", "GitHub CLI", "read-only", "features.json", "node --test", "disable", "rebuild"]) {
    assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "i"));
  }
});

test("protocol exports bounded operation sets and limits", () => {
  assert.deepEqual([...OPERATIONS], ["capabilities", "listIssues", "getIssue", "getIssueTimelinePage", "cancel"]);
  assert.deepEqual([...VIEWS], ["assigned", "authored", "all"]);
  assert.deepEqual([...STATES], ["open", "closed", "all"]);
  assert.deepEqual(LIMITS, { requestId: 96, host: 253, repository: 200, text: 500, cursor: 512, nodeId: 256 });
  assert.equal(Object.isFrozen(LIMITS), true);
});

test("protocol accepts a bounded list request and rejects supplied GraphQL", () => {
  assert.deepEqual(validateEnvelope({
    version: 1,
    requestId: "req-1",
    operation: "listIssues",
    input: { host: "github.com", view: "assigned", state: "open", repository: null, text: "parser", cursor: null },
  }).operation, "listIssues");
  assert.throws(() => validateEnvelope({
    version: 1,
    requestId: "req-2",
    operation: "listIssues",
    input: { host: "github.com", view: "assigned", state: "open", query: "mutation { deleteIssue }" },
  }), /unknown field: query/);
});

test("protocol normalizes by cloning envelopes and permits null-prototype objects", () => {
  const input = Object.create(null);
  input.version = 1;
  input.requestId = "req-clone";
  input.operation = "listIssues";
  input.input = Object.assign(Object.create(null), {
    host: "github.com",
    view: "all",
    state: "all",
    repository: null,
    text: "",
    cursor: null,
  });
  const normalized = validateEnvelope(input);
  assert.deepEqual(normalized, {
    version: 1,
    requestId: "req-clone",
    operation: "listIssues",
    input: { host: "github.com", view: "all", state: "all", repository: null, text: "", cursor: null },
  });
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.input, input.input);
});

test("protocol validates operation-specific inputs", () => {
  assert.deepEqual(validateEnvelope({ version: 1, requestId: "cap", operation: "capabilities", input: { host: null } }).input, { host: null });
  assert.deepEqual(validateEnvelope({ version: 1, requestId: "cancel", operation: "cancel", input: { targetRequestId: "req-1" } }).input, { targetRequestId: "req-1" });
  assert.deepEqual(validateEnvelope({ version: 1, requestId: "issue", operation: "getIssue", input: { host: "ghe.example.com", nodeId: "MDU6SXNzdWUx" } }).input, { host: "ghe.example.com", nodeId: "MDU6SXNzdWUx" });
  assert.deepEqual(validateEnvelope({ version: 1, requestId: "timeline", operation: "getIssueTimelinePage", input: { host: "github.com", nodeId: "MDU6SXNzdWUx", cursor: "cursor-1" } }).input.cursor, "cursor-1");
  assert.throws(() => validateEnvelope({ version: 1, requestId: "missing", operation: "getIssue", input: { host: "github.com" } }), /missing field: nodeId/);
  assert.throws(() => validateEnvelope({ version: 1, requestId: "missing", operation: "capabilities", input: {} }), /missing field: host/);
  assert.throws(() => validateEnvelope({ version: 1, requestId: "missing", operation: "cancel", input: {} }), /missing field: targetRequestId/);
});

test("protocol rejects unsafe objects, strings, hosts, repositories, and enums", () => {
  const valid = { version: 1, requestId: "req", operation: "listIssues", input: { host: "github.com", view: "assigned", state: "open", repository: null, text: "", cursor: null } };
  for (const value of [null, [], "text", 1, true]) {
    assert.throws(() => validateEnvelope(value), /object/);
  }
  const inherited = Object.create({ version: 1 });
  Object.assign(inherited, { requestId: "req", operation: "listIssues", input: valid.input });
  assert.throws(() => validateEnvelope(inherited), /prototype/);
  for (const [field, value] of [["requestId", "a".repeat(LIMITS.requestId + 1)], ["requestId", "req\u0000"], ["input.text", "a".repeat(LIMITS.text + 1)], ["input.cursor", "a".repeat(LIMITS.cursor + 1)], ["input.nodeId", "a".repeat(LIMITS.nodeId + 1)]]) {
    const candidate = field === "input.nodeId"
      ? { version: 1, requestId: "req", operation: "getIssue", input: { host: "github.com", nodeId: "node" } }
      : structuredClone(valid);
    if (field.startsWith("input.")) candidate.input[field.slice(6)] = value;
    else candidate[field] = value;
    assert.throws(() => validateEnvelope(candidate), /control character|too long/);
  }
  for (const host of ["not a host", "-github.com", "github..com", "https://github.com", ""] ) {
    assert.throws(() => validateEnvelope({ ...valid, input: { ...valid.input, host } }), /hostname/);
  }
  for (const repository of ["octocat", "octocat/", "/hello", "octo/cat/extra", "octo cat/hello", "octo/hello?x"]) {
    assert.throws(() => validateEnvelope({ ...valid, input: { ...valid.input, repository } }), /repository/);
  }
  assert.throws(() => validateEnvelope({ ...valid, input: { ...valid.input, text: null } }), /text/);
  assert.throws(() => validateEnvelope({ ...valid, input: { ...valid.input, view: "mine" } }), /view/);
  assert.throws(() => validateEnvelope({ ...valid, input: { ...valid.input, state: "pending" } }), /state/);
  assert.throws(() => validateEnvelope({ ...valid, operation: "nope" }), /operation/);
});

test("protocol validates response envelopes", () => {
  const response = validateResponse({ version: 1, requestId: "req-1", ok: true, data: { issues: [] }, error: null });
  assert.deepEqual(response, { version: 1, requestId: "req-1", ok: true, data: { issues: [] }, error: null });
  assert.throws(() => validateResponse({ version: 1, requestId: "req-1", ok: true, data: {}, error: { code: "bad" } }), /data|error/);
  assert.throws(() => validateResponse({ version: 1, requestId: "req-1", ok: false, data: null, error: null }), /error/);
});

test("preload patch exposes one namespaced request method", () => {
  const source = "bridge.exposeInMainWorld(`electronBridge`,{openExternal:e=>ipc.invoke(`open-external`,e),getSentryInitOptions:()=>opts})";
  const once = applyPreloadBridgePatch(source);
  assert.match(once, /githubIssues:\{request:e=>ipc\.invoke\(`codex-linux:github-issues`,e\)\}/);
  assert.equal(applyPreloadBridgePatch(once), once);
});

test("main patch registers one handler and adapter runner", () => {
  const source = "electron.ipcMain.handle(`codex_desktop:check-for-updates`,async e=>{});";
  const once = applyMainBridgePatch(source);
  assert.match(once, /codex-linux:github-issues/);
  assert.match(once, /issues-adapter\.js/);
  assert.equal(applyMainBridgePatch(once), once);
});

test("bridge sources expose fixed paths and no general command channel", () => {
  const source = mainBridgeSource();
  assert.match(source, /node-runtime/);
  assert.match(source, /bin/);
  assert.match(source, /issues-adapter\.js/);
  assert.match(mainBridgeSource(), /8\*1024\*1024|8388608/);
  assert.doesNotMatch(mainBridgeSource(), /shell|exec\(|spawnSync|openExternal/);
  assert.match(mainBridgeSource(), /codex-linux:github-issues/);
});

test("bridge patches preserve source when preload anchors drift or are ambiguous", () => {
  const missing = "bridge.exposeInMainWorld(`otherBridge`,{getSentryInitOptions:()=>opts})";
  assert.equal(applyPreloadBridgePatch(missing), missing);
  const ambiguous = [
    "bridge.exposeInMainWorld(`electronBridge`,{openExternal:e=>ipc.invoke(`open-external`,e),getSentryInitOptions:()=>opts})",
    "bridge.exposeInMainWorld(`electronBridge`,{openExternal:e=>other.invoke(`open-external`,e),getSentryInitOptions:()=>opts})",
  ].join(";");
  assert.equal(applyPreloadBridgePatch(ambiguous), ambiguous);
});

test("preload descriptor scans only .vite/build JavaScript and reports optional drift", () => {
  assert.equal(preloadDescriptor?.phase, "extracted-app:post-webview");
  assert.equal(preloadDescriptor?.ciPolicy, "optional");
  assert.equal(typeof preloadDescriptor?.apply, "function");
});

function createBridgeVm(spawn) {
  const handlers = new Map();
  const processListeners = new Map();
  const processKills = [];
  const ipcMain = { handle(channel, handler) { handlers.set(channel, handler); } };
  const processObject = {
    resourcesPath: "/opt/codex/resources",
    pid: 9999,
    kill(...args) { processKills.push(args); },
    on(event, callback) { processListeners.set(event, callback); return processObject; },
  };
  const context = {
    Buffer,
    console,
    process: processObject,
    require(name) {
      if (name === "node:path") return path;
      if (name === "node:child_process") return { spawn };
      throw new Error(`unexpected require ${name}`);
    },
    ipcMain,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.runInNewContext(mainBridgeSource("ipcMain"), context);
  const handler = handlers.get("codex-linux:github-issues");
  handler.toVm = (value) => vm.runInNewContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
  handler.vm = (expression) => vm.runInNewContext(expression, context);
  handler.emitExit = () => processListeners.get("exit")?.();
  handler.processKills = processKills;
  return handler;
}

function fakeChild() {
  const listeners = new Map();
  const child = {
    killed: false,
    stdin: { end() {} },
    stdout: { on(event, callback) { listeners.set(`stdout:${event}`, callback); return child.stdout; } },
    stderr: { on(event, callback) { listeners.set(`stderr:${event}`, callback); return child.stderr; } },
    on(event, callback) { listeners.set(event, callback); return child; },
    kill() { child.killed = true; if (!child.noClose) listeners.get("close")?.(null, "SIGTERM"); },
    emit(event, ...args) { listeners.get(event)?.(...args); },
    emitStdout(value) { listeners.get("stdout:data")?.(value); },
  };
  return child;
}

const capabilitiesRequest = {
  version: 1,
  requestId: "req-1",
  operation: "capabilities",
  input: { host: "github.com" },
};

test("main bridge validates unknown operations before spawning", async () => {
  const calls = [];
  const handler = createBridgeVm(() => {
    calls.push(true);
    return fakeChild();
  });
  const response = await handler({}, handler.toVm({ ...capabilitiesRequest, operation: "shell", input: {} }));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "invalid-request");
  assert.equal(calls.length, 0);
});

test("main bridge rejects duplicate ids and cancellation only kills its child", async () => {
  const children = [];
  const handler = createBridgeVm(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  const first = handler({}, handler.toVm(capabilitiesRequest));
  await Promise.resolve();
  const duplicate = await handler({}, handler.toVm(capabilitiesRequest));
  assert.equal(duplicate.error.code, "duplicate-request");
  const secondRequest = { ...capabilitiesRequest, requestId: "req-2" };
  const second = handler({}, handler.toVm(secondRequest));
  await Promise.resolve();
  const cancellation = await handler({}, handler.toVm({
    version: 1,
    requestId: "cancel-1",
    operation: "cancel",
    input: { targetRequestId: "req-1" },
  }));
  assert.equal(cancellation.ok, true);
  assert.equal(children[0].killed, true);
  assert.equal(children[1].killed, false);
  children[1].emitStdout(JSON.stringify({ version: 1, requestId: "req-2", ok: true, data: {}, error: null }));
  children[1].emit("close", 0, null);
  await Promise.all([first, second]);
});

test("main bridge rejects adapter output above the 8 MiB cap", async () => {
  const child = fakeChild();
  const handler = createBridgeVm(() => child);
  const request = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "large" }));
  await Promise.resolve();
  child.emitStdout(Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  const response = await request;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "output-limit");
});

test("main bridge mirrors protocol records and permits empty list text", async () => {
  const children = [];
  const handler = createBridgeVm(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  const list = {
    version: 1,
    requestId: "empty-text",
    operation: "listIssues",
    input: { host: "github.com", view: "assigned", state: "open", repository: null, text: "", cursor: null },
  };
  const pending = handler({}, handler.toVm(list));
  await Promise.resolve();
  assert.equal(children.length, 1);
  children[0].emitStdout(JSON.stringify({ version: 1, requestId: "empty-text", ok: true, data: {}, error: null }));
  children[0].emit("close", 0, null);
  assert.equal((await pending).ok, true);

  const invalidHost = handler.toVm({ ...list, requestId: "long-host", input: { ...list.input, host: "a".repeat(254) } });
  const customPrototype = handler.vm(`Object.assign(Object.create({ inherited: true }), ${JSON.stringify(list)})`);
  const inheritedField = handler.vm(`Object.assign(Object.create(null), ${JSON.stringify(list)}, { inherited: true })`);
  for (const invalid of [invalidHost, customPrototype, inheritedField]) {
    const response = await handler({}, invalid);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "invalid-request");
  }
  assert.equal(children.length, 1);
});

test("main patch selects exactly one trusted update handler and ignores unrelated handlers", () => {
  const source = [
    "electron.ipcMain.handle(`other-channel`,async e=>{});",
    "electron.ipcMain.handle(`codex_desktop:check-for-updates`,async e=>{});",
  ].join("\n");
  const patched = applyMainBridgePatch(source);
  assert.notEqual(patched, source);
  assert.equal((patched.match(/codex-linux:github-issues/g) ?? []).length, 1);
  const missing = "electron.ipcMain.handle(`other-channel`,async e=>{});";
  assert.equal(applyMainBridgePatch(missing), missing);
  const ambiguous = [
    "electron.ipcMain.handle(`codex_desktop:check-for-updates`,async e=>{});",
    "electron.ipcMain.handle(`codex_desktop:check-for-updates`,async e=>{});",
  ].join("\n");
  assert.equal(applyMainBridgePatch(ambiguous), ambiguous);
});

test("main bridge terminates only owned process groups and cleans up on exit", async () => {
  const children = [];
  const handler = createBridgeVm(() => {
    const child = fakeChild();
    child.pid = 4000 + children.length;
    children.push(child);
    return child;
  });
  const first = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "owned-1" }));
  const second = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "owned-2" }));
  await Promise.resolve();
  const cancellation = await handler({}, handler.toVm({ version: 1, requestId: "cancel-owned", operation: "cancel", input: { targetRequestId: "owned-1" } }));
  assert.equal(cancellation.ok, true);
  assert.equal(children[0].killed, false);
  assert.deepEqual(handler.processKills, [[-4000, "SIGTERM"]]);
  handler.emitExit();
  assert.deepEqual(handler.processKills, [[-4000, "SIGTERM"], [-4001, "SIGTERM"]]);
  assert.equal(children[1].killed, false);
  const afterExit = await handler({}, handler.toVm({ version: 1, requestId: "cancel-after-exit", operation: "cancel", input: { targetRequestId: "owned-2" } }));
  assert.equal(afterExit.error.code, "not-found");
  children[0].emit("close", null, "SIGTERM");
  children[1].emit("close", null, "SIGTERM");
  await Promise.all([first, second]);
});

test("main bridge ignores stdout and process events after settlement", async () => {
  const child = fakeChild();
  child.pid = 7000;
  const handler = createBridgeVm(() => child);
  const pending = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "settled" }));
  await Promise.resolve();
  child.emitStdout(JSON.stringify({ version: 1, requestId: "settled", ok: true, data: {}, error: null }));
  child.emit("close", 0, null);
  const response = await pending;
  child.emitStdout(Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  child.emit("error", new Error("late"));
  child.emit("close", 1, null);
  assert.equal(response.ok, true);
  assert.equal(child.killed, false);
});

test("main bridge keeps cancelled ownership until the original child settles", async () => {
  const children = [];
  const handler = createBridgeVm(() => {
    const child = fakeChild();
    child.pid = 8000 + children.length;
    child.noClose = true;
    children.push(child);
    return child;
  });
  const first = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "reuse" }));
  await Promise.resolve();
  const cancelled = await handler({}, handler.toVm({ version: 1, requestId: "cancel-reuse", operation: "cancel", input: { targetRequestId: "reuse" } }));
  assert.equal(cancelled.ok, true);
  const duplicate = await handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "reuse" }));
  assert.equal(duplicate.error.code, "duplicate-request");
  const second = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "keep" }));
  await Promise.resolve();
  const cancelSecond = await handler({}, handler.toVm({ version: 1, requestId: "cancel-keep", operation: "cancel", input: { targetRequestId: "keep" } }));
  assert.equal(cancelSecond.ok, true);
  children[0].emit("close", null, "SIGTERM");
  await first;
  const reused = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "reuse" }));
  await Promise.resolve();
  assert.equal(children.length, 3);
  children[2].emitStdout(JSON.stringify({ version: 1, requestId: "reuse", ok: true, data: {}, error: null }));
  children[2].emit("close", 0, null);
  await reused;
  handler.emitExit();
  assert.deepEqual(handler.processKills, [[-8000, "SIGTERM"], [-8001, "SIGTERM"]]);
  children[1].emit("close", null, "SIGTERM");
});

test("main bridge rejects a cancel envelope whose id is already in flight", async () => {
  const child = fakeChild();
  const handler = createBridgeVm(() => child);
  const original = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "same" }));
  await Promise.resolve();
  const duplicateCancel = await handler({}, handler.toVm({
    version: 1,
    requestId: "same",
    operation: "cancel",
    input: { targetRequestId: "same" },
  }));
  assert.equal(duplicateCancel.error.code, "duplicate-request");
  assert.equal(child.killed, false);
  const uniqueCancel = await handler({}, handler.toVm({
    version: 1,
    requestId: "cancel-same",
    operation: "cancel",
    input: { targetRequestId: "same" },
  }));
  assert.equal(uniqueCancel.ok, true);
  await original;
});

test("main bridge clones adapter __proto__ data without prototype pollution", async () => {
  const child = fakeChild();
  const handler = createBridgeVm(() => child);
  const pending = handler({}, handler.toVm({ ...capabilitiesRequest, requestId: "proto-data" }));
  await Promise.resolve();
  child.emitStdout('{"version":1,"requestId":"proto-data","ok":true,"data":{"__proto__":{"polluted":true}},"error":null}');
  child.emit("close", 0, null);
  const response = await pending;
  assert.equal(response.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(response.data, "__proto__"), true);
  assert.equal(response.data.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("preload patch requires an actual getSentryInitOptions property", () => {
  const falsePositive = "bridge.exposeInMainWorld(`electronBridge`,{note:`getSentryInitOptions`,openExternal:e=>ipc.invoke(`open-external`,e)})";
  assert.equal(applyPreloadBridgePatch(falsePositive), falsePositive);
  const methodProperty = "bridge.exposeInMainWorld(`electronBridge`,{getSentryInitOptions(){return opts},openExternal:e=>ipc.invoke(`open-external`,e)})";
  assert.match(applyPreloadBridgePatch(methodProperty), /githubIssues:\{request:e=>ipc\.invoke\(`codex-linux:github-issues`,e\)\}/);
});

test("preload descriptor patches one .vite/build bundle and leaves other paths untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-issues-bridge-"));
  fs.mkdirSync(path.join(root, ".vite", "build"), { recursive: true });
  const source = "bridge.exposeInMainWorld(`electronBridge`,{openExternal:e=>ipc.invoke(`open-external`,e),getSentryInitOptions:()=>opts})";
  const inside = path.join(root, ".vite", "build", "preload.js");
  const outside = path.join(root, "preload.js");
  fs.writeFileSync(inside, source);
  fs.writeFileSync(outside, source);
  assert.deepEqual(patchPreloadBridgeAssets(root), { matched: true, changed: 1 });
  assert.match(fs.readFileSync(inside, "utf8"), /codex-linux:github-issues/);
  assert.equal(fs.readFileSync(outside, "utf8"), source);
  assert.deepEqual(patchPreloadBridgeAssets(root), { matched: true, changed: 0 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("preload descriptor reports an ambiguous bridge anchor as optional drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-issues-bridge-drift-"));
  fs.mkdirSync(path.join(root, ".vite", "build"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".vite", "build", "preload.js"),
    "bridge.exposeInMainWorld(`electronBridge`,{getSentryInitOptions:()=>opts})",
  );
  const result = patchPreloadBridgeAssets(root);
  assert.equal(result.matched, false);
  assert.equal(optionalDriftStatus(result, [] ).status, "skipped-optional");
  fs.rmSync(root, { recursive: true, force: true });
});
