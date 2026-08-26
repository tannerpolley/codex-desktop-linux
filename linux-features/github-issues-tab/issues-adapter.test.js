"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "list-assigned.json"), "utf8"));
const partialFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "partial-list.json"), "utf8"));
const capabilitiesFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "capabilities.json"), "utf8"));
const detailFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "issue-detail.json"), "utf8"));
const timelinePage2Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "timeline-page-2.json"), "utf8"));
const timelinePartialFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "timeline-partial.json"), "utf8"));
const {
  buildSearchQuery,
  parseRepositoryRemote,
  normalizeIssue,
  normalizeTimelineItem,
  getIssue,
  getIssueTimelinePage,
  runOperation,
  QUERIES,
} = require("./issues-adapter.js");
const ADAPTER_PATH = path.join(__dirname, "issues-adapter.js");
const VERSION = { stdout: "gh version 2.81.0 (2026-07-17)\ngithub.com/cli/cli v2.81.0\n" };
const AUTH = { stdout: JSON.stringify({ hosts: { "github.com": [{ host: "github.com", userLogin: "octocat", active: true, state: "success" }] } }) };
const byType = Object.fromEntries(detailFixture.data.node.timelineItems.nodes.map((node) => [node.__typename, node]));

test("buildSearchQuery scopes account views and repository-wide All views correctly", () => {
  assert.equal(buildSearchQuery({ view: "assigned", state: "open", repository: null, text: "" }, "octocat"), "is:issue assignee:octocat is:open sort:updated-desc");
  assert.equal(buildSearchQuery({ view: "authored", state: "closed", repository: "openai/codex", text: "race" }, "octocat"), "is:issue author:octocat is:closed repo:openai/codex race sort:updated-desc");
  assert.equal(buildSearchQuery({ view: "all", state: "all", repository: null, text: "" }, "octocat"), "is:issue involves:octocat sort:updated-desc");
  assert.equal(buildSearchQuery({ view: "all", state: "open", repository: "cli/cli", text: "" }, "octocat"), "is:issue is:open repo:cli/cli sort:updated-desc");
});

test("parseRepositoryRemote accepts GitHub HTTPS and SSH origins", () => {
  assert.deepEqual(parseRepositoryRemote("https://github.com/openai/codex.git"), { host: "github.com", repository: "openai/codex" });
  assert.deepEqual(parseRepositoryRemote("git@github.com:openai/codex.git"), { host: "github.com", repository: "openai/codex" });
  assert.deepEqual(parseRepositoryRemote("ssh://git@ghe.example.com/openai/codex"), { host: "ghe.example.com", repository: "openai/codex" });
  assert.deepEqual(parseRepositoryRemote("https://gitlab.com/openai/codex.git"), { host: "gitlab.com", repository: "openai/codex" });
  for (const remote of ["", "https://github.com/openai/codex/extra.git", "not-a-remote"]) {
    assert.equal(parseRepositoryRemote(remote), null);
  }
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

test("detail and timeline documents use schema-valid timeline union selections", () => {
  for (const query of [QUERIES.detail, QUERIES.timeline]) {
    assert.match(query, /assignee \{\s+__typename/);
    for (const concreteType of ["Bot", "Mannequin", "Organization", "User"]) {
      assert.match(query, new RegExp(`\\.\\.\\. on ${concreteType} \\{\\s+login\\s+\\}`));
    }
    assert.match(query, /milestoneTitle/);
    assert.doesNotMatch(query, /\.\.\. on MilestonedEvent \{ id createdAt actor \{ login \} milestone \{/);
    assert.doesNotMatch(query, /\.\.\. on DemilestonedEvent \{ id createdAt actor \{ login \} milestone \{/);
    assert.match(query, /issue \{[\s\S]*repository \{ nameWithOwner \}/);
    assert.doesNotMatch(query, /toRepository/);
    assert.match(query, /nodes \{\s+__typename\s+\.\.\. on Node \{ id \}/);
  }
});

test("detail query stays within core scopes when project data is unavailable", () => {
  assert.doesNotMatch(QUERIES.detail, /projectItems|projectsV2/);
});

for (const [type, expectedKind] of [
  ["IssueComment", "comment"],
  ["LabeledEvent", "label"],
  ["UnlabeledEvent", "label"],
  ["AssignedEvent", "assignment"],
  ["UnassignedEvent", "assignment"],
  ["MilestonedEvent", "milestone"],
  ["DemilestonedEvent", "milestone"],
  ["ClosedEvent", "state"],
  ["ReopenedEvent", "state"],
  ["RenamedTitleEvent", "rename"],
  ["ReferencedEvent", "reference"],
  ["CrossReferencedEvent", "reference"],
  ["TransferredEvent", "transfer"],
  ["FutureIssueEvent", "generic"],
]) {
  test(`normalizes ${type}`, () => {
    assert.equal(normalizeTimelineItem(byType[type], "github.com").kind, expectedKind);
  });
}

test("unknown timeline nodes retain type and time", () => {
  assert.deepEqual(normalizeTimelineItem(byType.FutureIssueEvent, "github.com"), {
    id: "future-1",
    kind: "generic",
    type: "FutureIssueEvent",
    createdAt: "2026-07-17T00:00:00Z",
    actor: null,
  });
});

test("timeline normalization tolerates deleted actors and private references", () => {
  assert.equal(normalizeTimelineItem(byType.UnassignedEvent, "github.com").actor, null);
  assert.equal(normalizeTimelineItem(byType.CrossReferencedEvent, "github.com").target, null);
  assert.equal(normalizeTimelineItem(byType.DemilestonedEvent, "github.com").milestone, null);
  const missingAssignee = structuredClone(byType.AssignedEvent);
  delete missingAssignee.assignee;
  assert.equal(normalizeTimelineItem(missingAssignee, "github.com").assignee, null);
});

test("timeline normalizers map schema-valid milestone and transfer fields", () => {
  assert.deepEqual(normalizeTimelineItem(byType.MilestonedEvent, "github.com").milestone, {
    title: "v1",
    number: null,
    state: null,
    dueOn: null,
  });
  assert.equal(normalizeTimelineItem(byType.TransferredEvent, "github.com").fromRepository, "old/codex");
  assert.equal(normalizeTimelineItem(byType.TransferredEvent, "github.com").toRepository, "openai/codex");
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
      if (response?.hang) return;
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
      VERSION,
      AUTH,
      { stdout: JSON.stringify(capabilitiesFixture) },
    ], calls),
    ghPath: "gh",
  });
  assert.deepEqual(data, {
    host: "github.com",
    viewerLogin: "octocat",
    repository: null,
    rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-07-17T18:00:00Z" },
  });
  assert.equal(calls[0].command, "gh");
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.deepEqual(calls[1].args, ["auth", "status", "--json", "hosts"]);
  assert.equal(calls[2].args[0], "api");
  assert.equal(calls[2].args.includes("--show-token"), false);
  assert.equal(JSON.parse(calls[2].stdin).query, QUERIES.capabilities);
});

test("capabilities resolves the workspace origin before querying GitHub", async () => {
  const calls = [];
  const data = await runOperation({ version: 1, requestId: "cap-root", operation: "capabilities", input: { host: null, root: "/workspaces/codex" } }, {
    spawn: fakeSpawn([
      VERSION,
      AUTH,
      { stdout: "git@github.com:openai/codex.git\n" },
      { stdout: JSON.stringify(capabilitiesFixture) },
    ], calls),
    ghPath: "gh",
  });
  assert.equal(data.repository, "openai/codex");
  assert.equal(calls[2].command, "git");
  assert.deepEqual(calls[2].args, ["-C", "/workspaces/codex", "config", "--get", "remote.origin.url"]);
  assert.equal(calls[3].command, "gh");
});

test("runOperation lists, deduplicates, preserves partial data, and never shells text", async () => {
  const calls = [];
  const literal = "$(touch nope); \"quoted\"";
  const result = await runOperation({ version: 1, requestId: "list", operation: "listIssues", input: { host: "github.com", view: "assigned", state: "open", repository: "openai/codex", text: literal, cursor: "cursor-1" } }, {
    spawn: fakeSpawn([
      VERSION,
      AUTH,
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
  const request = JSON.parse(calls[3].stdin);
  assert.equal(request.variables.search.includes(literal), true);
  assert.equal(calls.some(({ command, args }) => command.includes("sh") || args.includes("-c")), false);
});

test("runOperation keeps process output bounded and reports sanitized failures", async () => {
  const calls = [];
  await assert.rejects(
    runOperation({ version: 1, requestId: "too-big", operation: "capabilities", input: { host: "github.com" } }, {
      spawn: fakeSpawn([VERSION, AUTH, { stdout: "x".repeat(8 * 1024 * 1024 + 1) }], calls),
      ghPath: "gh",
    }),
    (error) => error?.type === "invalid-response" && !error.message.includes("x".repeat(32)),
  );

  await assert.rejects(
    runOperation({ version: 1, requestId: "offline", operation: "capabilities", input: { host: "github.com" } }, {
      spawn: fakeSpawn([VERSION, AUTH, { code: 1, stderr: `private response ${"x".repeat(100_000)}` }], []),
      ghPath: "gh",
    }),
    (error) => error?.type === "adapter-failed" && !error.message.includes("private response"),
  );
});

test("runOperation times out a hung GitHub CLI process without leaking response data", async () => {
  const calls = [];
  await assert.rejects(
    runOperation({ version: 1, requestId: "timeout", operation: "capabilities", input: { host: null } }, {
      spawn: fakeSpawn([VERSION, { hang: true }], calls),
      ghPath: "gh",
      timeoutMs: 5,
    }),
    (error) => error?.type === "offline" && error.message === "GitHub could not be reached",
  );
  assert.equal(calls.length, 2);
});

test("runOperation sanitizes missing CLI and GraphQL authorization/rate-limit failures", async () => {
  const missing = new Error("spawn gh ENOENT");
  missing.code = "ENOENT";
  await assert.rejects(
    runOperation({ version: 1, requestId: "missing", operation: "capabilities", input: { host: null } }, {
      spawn: fakeSpawn([{ error: missing }], []),
      ghPath: "gh",
    }),
    (error) => error?.type === "gh-missing" && !error.message.includes("ENOENT"),
  );

  for (const [type, message] of [["UNAUTHORIZED", "forbidden"], ["RATE_LIMITED", "rate limit"]]) {
    await assert.rejects(
      runOperation({ version: 1, requestId: type, operation: "capabilities", input: { host: null } }, {
        spawn: fakeSpawn([VERSION, AUTH, { stdout: JSON.stringify({ data: null, errors: [{ type, message }] }) }], []),
        ghPath: "gh",
      }),
      (error) => error?.type === (type === "UNAUTHORIZED" ? "unauthorized" : "rate-limited") && !error.message.includes(message),
    );
  }
});

test("runOperation maps GraphQL exit code 4 to sanitized auth-required", async () => {
  await assert.rejects(
    runOperation({ version: 1, requestId: "exit-four", operation: "capabilities", input: { host: "github.com" } }, {
      spawn: fakeSpawn([VERSION, AUTH, { code: 4 }], []),
      ghPath: "gh",
    }),
    (error) => error?.type === "auth-required" && !error.message.includes("4"),
  );
});

test("version gate rejects old and malformed GitHub CLI before auth or GraphQL", async () => {
  for (const stdout of ["gh version 2.80.0\n", "gh version 2.45.0\n", "not-semver\n"]) {
    const calls = [];
    await assert.rejects(
      runOperation({ version: 1, requestId: "version", operation: "capabilities", input: { host: null } }, {
        spawn: fakeSpawn([{ stdout }], calls),
        ghPath: "gh",
      }),
      (error) => error?.type === "gh-upgrade-required",
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["--version"]);
  }
});

test("version 2.81.0 proceeds to authenticated host discovery", async () => {
  const calls = [];
  const result = await runOperation({ version: 1, requestId: "version-ok", operation: "capabilities", input: { host: null } }, {
    spawn: fakeSpawn([VERSION, AUTH, { stdout: JSON.stringify(capabilitiesFixture) }], calls),
    ghPath: "gh",
  });
  assert.equal(result.viewerLogin, "octocat");
  assert.deepEqual(calls.map(({ args }) => args[0]), ["--version", "auth", "api"]);
});

test("rejects unauthenticated host entries and selects an authenticated Enterprise host", async () => {
  for (const hosts of [
    [{ host: "github.com", active: true, state: "error" }],
    { "github.com": [{ host: "github.com", active: true, state: "timeout" }] },
    { "github.com": [{ host: "github.com", active: false, state: "success" }] },
  ]) {
    const calls = [];
    await assert.rejects(
      runOperation({ version: 1, requestId: "auth", operation: "capabilities", input: { host: null } }, {
        spawn: fakeSpawn([VERSION, { stdout: JSON.stringify({ hosts }) }], calls),
        ghPath: "gh",
      }),
      (error) => error?.type === "auth-required",
    );
    assert.equal(calls.length, 2);
  }

  const calls = [];
  const enterpriseHosts = {
    "github.com": [{ host: "github.com", active: true, state: "success" }],
    "ghe.example.com": [{ host: "ghe.example.com", active: true, state: "success" }],
  };
  const result = await runOperation({ version: 1, requestId: "enterprise", operation: "capabilities", input: { host: "ghe.example.com" } }, {
    spawn: fakeSpawn([VERSION, { stdout: JSON.stringify({ hosts: enterpriseHosts }) }, { stdout: JSON.stringify(capabilitiesFixture) }], calls),
    ghPath: "gh",
  });
  assert.equal(result.host, "ghe.example.com");
  assert.equal(calls[2].args.includes("ghe.example.com"), true);
});

test("retains usable issues when GraphQL pageInfo is null", async () => {
  const partialPage = structuredClone(partialFixture);
  partialPage.data.search.pageInfo = null;
  partialPage.errors = [{ type: "FIELD_ERROR", path: ["search", "pageInfo"] }];
  const calls = [];
  const result = await runOperation({ version: 1, requestId: "partial-page", operation: "listIssues", input: { host: "github.com", view: "assigned", state: "open", repository: "openai/codex", text: "", cursor: null } }, {
    spawn: fakeSpawn([VERSION, AUTH, { stdout: JSON.stringify(capabilitiesFixture) }, { stdout: JSON.stringify(partialPage) }], calls),
    ghPath: "gh",
  });
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.pageInfo, { hasNextPage: false, endCursor: null });
  assert.deepEqual(result.warnings, [{ type: "FIELD_ERROR", path: ["search", "pageInfo"] }]);
});

test("CLI emits the required sanitized response envelope", () => {
  const result = spawnSync(process.execPath, [ADAPTER_PATH], { input: "not-json", encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    requestId: "invalid-request",
    ok: false,
    data: null,
    error: { code: "invalid-response", message: "Invalid adapter request" },
  });
});

test("getIssue returns normalized metadata, Markdown body, projects, and timeline page", async () => {
  const calls = [];
  const result = await runOperation({ version: 1, requestId: "detail", operation: "getIssue", input: { host: "github.com", nodeId: "issue-1" } }, {
    spawn: fakeSpawn([
      VERSION,
      AUTH,
      { stdout: JSON.stringify(detailFixture) },
    ], calls),
    ghPath: "gh",
  });
  assert.equal(result.issue.id, "issue-1");
  assert.equal(result.issue.body, "# Parser errors\n\nDetails in Markdown.");
  assert.deepEqual(result.issue.projects, []);
  assert.equal(result.timeline.items.length, 14);
  assert.deepEqual(result.timeline.pageInfo, { hasNextPage: true, endCursor: "timeline-cursor-1" });
  assert.deepEqual(result.rateLimit, { cost: 10, remaining: 4980, resetAt: "2026-07-17T18:00:00Z" });
  assert.deepEqual(result.warnings, []);
  const request = JSON.parse(calls[2].stdin);
  assert.equal(request.variables.nodeId, "issue-1");
  assert.equal(request.variables.cursor, null);
  assert.match(request.query, /body/);
  assert.match(request.query, /timelineItems\(first: 50, after: \$cursor\)/);
  assert.doesNotMatch(request.query, /bodyHTML|renderedBody/);
});

test("getIssueTimelinePage returns a normalized continuation page and preserves partial items", async () => {
  const calls = [];
  const result = await runOperation({ version: 1, requestId: "timeline", operation: "getIssueTimelinePage", input: { host: "github.com", nodeId: "issue-1", cursor: "timeline-cursor-1" } }, {
    spawn: fakeSpawn([
      VERSION,
      AUTH,
      { stdout: JSON.stringify(timelinePartialFixture) },
    ], calls),
    ghPath: "gh",
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].actor, null);
  assert.deepEqual(result.pageInfo, { hasNextPage: false, endCursor: null });
  assert.deepEqual(result.rateLimit, { cost: 4, remaining: 4972, resetAt: "2026-07-17T18:00:00Z" });
  assert.deepEqual(result.warnings, [{ type: "FIELD_ERROR", path: ["node", "timelineItems", "pageInfo"] }]);
  const request = JSON.parse(calls[2].stdin);
  assert.equal(request.variables.nodeId, "issue-1");
  assert.equal(request.variables.cursor, "timeline-cursor-1");
  assert.equal(request.query, QUERIES.timeline);
});

test("getIssueTimelinePage normalizes a complete second page", async () => {
  const result = await runOperation({ version: 1, requestId: "timeline-2", operation: "getIssueTimelinePage", input: { host: "github.com", nodeId: "issue-1", cursor: "timeline-cursor-1" } }, {
    spawn: fakeSpawn([
      VERSION,
      AUTH,
      { stdout: JSON.stringify(timelinePage2Fixture) },
    ], []),
    ghPath: "gh",
  });
  assert.deepEqual(result.items.map((item) => item.id), ["comment-1", "comment-2"]);
  assert.equal(result.items[1].kind, "comment");
  assert.deepEqual(result.pageInfo, { hasNextPage: false, endCursor: null });
  assert.deepEqual(result.warnings, []);
});
