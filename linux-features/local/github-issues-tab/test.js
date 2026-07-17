#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
