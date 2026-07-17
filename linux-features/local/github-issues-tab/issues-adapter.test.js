"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "list-assigned.json"), "utf8"));
const partialFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "partial-list.json"), "utf8"));
const capabilitiesFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "capabilities.json"), "utf8"));
const {
  buildSearchQuery,
  normalizeIssue,
  runOperation,
  QUERIES,
} = require("./issues-adapter.js");

test("buildSearchQuery creates account-scoped inbox searches", () => {
  assert.equal(buildSearchQuery({ view: "assigned", state: "open", repository: null, text: "" }, "octocat"), "is:issue assignee:octocat is:open sort:updated-desc");
  assert.equal(buildSearchQuery({ view: "authored", state: "closed", repository: "openai/codex", text: "race" }, "octocat"), "is:issue author:octocat is:closed repo:openai/codex race sort:updated-desc");
  assert.equal(buildSearchQuery({ view: "all", state: "all", repository: null, text: "" }, "octocat"), "is:issue involves:octocat sort:updated-desc");
});

test("normalizeIssue removes GraphQL shape from renderer data", () => {
  const issue = normalizeIssue(fixture.data.search.nodes[0], "github.com");
  assert.deepEqual(Object.keys(issue).sort(), ["assignees", "author", "commentCount", "createdAt", "host", "id", "labels", "milestone", "number", "repository", "state", "stateReason", "title", "updatedAt", "url"]);
  assert.equal(issue.host, "github.com");
  assert.equal(issue.repository, "openai/codex");
  assert.equal(issue.author, "octocat");
  assert.deepEqual(issue.labels, [{ name: "bug", color: "d73a4a", description: "Something is not working" }]);
  assert.deepEqual(issue.assignees, ["octocat"]);
  assert.deepEqual(issue.milestone, { title: "v1", number: 1, state: "OPEN", dueOn: "2026-08-01T00:00:00Z" });
  assert.equal(issue.commentCount, 4);
});

function fakeSpawn(responses, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options, stdin: "" });
    const call = calls[calls.length - 1];
    const response = responses.shift();
    const listeners = new Map();
    const child = {
      stdin: {
        write(value) { call.stdin += value; },
        end(value) { if (value) call.stdin += value; },
      },
      stdout: { on(event, handler) { listeners.set(`stdout:${event}`, handler); } },
      stderr: { on(event, handler) { listeners.set(`stderr:${event}`, handler); } },
      on(event, handler) { listeners.set(event, handler); return child; },
      kill() { listeners.get("close")?.(null, "SIGTERM"); },
    };
    queueMicrotask(() => {
      if (response?.error) return listeners.get("error")?.(response.error);
      if (response?.stdout) listeners.get("stdout:data")?.(Buffer.from(response.stdout));
      if (response?.stderr) listeners.get("stderr:data")?.(Buffer.from(response.stderr));
      listeners.get("stdout:end")?.();
      listeners.get("stderr:end")?.();
      listeners.get("close")?.(response?.code ?? 0, null);
    });
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    return child;
  };
}

test("runOperation resolves the active host and returns capabilities", async () => {
  const calls = [];
  const data = await runOperation({ version: 1, requestId: "cap", operation: "capabilities", input: { host: null } }, {
    spawn: fakeSpawn([
      { stdout: JSON.stringify({ hosts: { "github.com": [{ userLogin: "octocat", active: true }] } }) },
      { stdout: JSON.stringify(capabilitiesFixture) },
    ], calls),
    ghPath: "gh",
  });
  assert.deepEqual(data, {
    host: "github.com",
    viewerLogin: "octocat",
    rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-07-17T18:00:00Z" },
  });
  assert.equal(calls[0].command, "gh");
  assert.deepEqual(calls[0].args, ["auth", "status", "--json", "hosts"]);
  assert.equal(calls[1].args[0], "api");
  assert.equal(calls[1].args.includes("--show-token"), false);
  assert.equal(JSON.parse(calls[1].stdin).query, QUERIES.capabilities);
});

test("runOperation lists, deduplicates, preserves partial data, and never shells text", async () => {
  const calls = [];
  const literal = "$(touch nope); \"quoted\"";
  const result = await runOperation({ version: 1, requestId: "list", operation: "listIssues", input: { host: "github.com", view: "assigned", state: "open", repository: null, text: literal, cursor: "cursor-1" } }, {
    spawn: fakeSpawn([
      { stdout: JSON.stringify({ hosts: { "github.com": [{ userLogin: "octocat", active: true }] } }) },
      { stdout: JSON.stringify(capabilitiesFixture) },
      { stdout: JSON.stringify(partialFixture) },
    ], calls),
    ghPath: "gh",
  });
  assert.equal(result.host, "github.com");
  assert.equal(result.viewerLogin, "octocat");
  assert.equal(result.issues.length, 1);
  assert.equal(result.pageInfo.hasNextPage, true);
  assert.equal(result.pageInfo.endCursor, "cursor-2");
  assert.deepEqual(result.warnings, [{ type: "FORBIDDEN", path: ["search", "nodes", 1, "title"] }]);
  const request = JSON.parse(calls[2].stdin);
  assert.equal(request.variables.search.includes(literal), true);
  assert.equal(calls.some(({ command, args }) => command.includes("sh") || args.includes("-c")), false);
});

test("runOperation keeps process output bounded and reports sanitized failures", async () => {
  const calls = [];
  await assert.rejects(
    runOperation({ version: 1, requestId: "too-big", operation: "capabilities", input: { host: "github.com" } }, {
      spawn: fakeSpawn([{ stdout: JSON.stringify({ hosts: { "github.com": [{ active: true }] } }) }, { stdout: "x".repeat(8 * 1024 * 1024 + 1) }], calls),
      ghPath: "gh",
    }),
    (error) => error?.type === "invalid-response" && !error.message.includes("x".repeat(32)),
  );

  await assert.rejects(
    runOperation({ version: 1, requestId: "offline", operation: "capabilities", input: { host: "github.com" } }, {
      spawn: fakeSpawn([{ stdout: JSON.stringify({ hosts: { "github.com": [{ active: true }] } }) }, { code: 1, stderr: `private response ${"x".repeat(100_000)}` }], []),
      ghPath: "gh",
    }),
    (error) => error?.type === "adapter-failed" && !error.message.includes("private response"),
  );
});
