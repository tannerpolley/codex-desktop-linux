#!/usr/bin/env node
"use strict";

const { spawn: defaultSpawn } = require("node:child_process");
const { LIMITS, validateEnvelope } = require("./protocol.js");

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_GH_VERSION = Object.freeze([2, 81, 0]);

const QUERIES = Object.freeze({
  capabilities: "query CodexLinuxIssuesCapabilities { viewer { login } rateLimit { cost remaining resetAt } }",
  list: `query CodexLinuxIssuesList($search: String!, $cursor: String) {
  search(query: $search, type: ISSUE, first: 30, after: $cursor) {
    nodes {
      ... on Issue {
        id
        number
        title
        url
        state
        stateReason
        createdAt
        updatedAt
        author { login }
        repository { nameWithOwner name owner { login } }
        labels(first: 20) { nodes { name color description } }
        assignees(first: 10) { nodes { login } }
        milestone { title number state dueOn }
        comments { totalCount }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
  rateLimit { cost remaining resetAt }
}`,
});
const CAPABILITIES_QUERY = QUERIES.capabilities;
const LIST_QUERY = QUERIES.list;

class AdapterError extends Error {
  constructor(type, message) {
    super(message);
    this.name = "AdapterError";
    this.type = type;
  }
}

function fixedError(type, message = type) {
  return new AdapterError(type, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildSearchQuery(input, viewerLogin) {
  const terms = ["is:issue"];
  if (input.view === "assigned") terms.push(`assignee:${viewerLogin}`);
  else if (input.view === "authored") terms.push(`author:${viewerLogin}`);
  else terms.push(`involves:${viewerLogin}`);
  if (input.state !== "all") terms.push(`is:${input.state}`);
  if (input.repository !== null) terms.push(`repo:${input.repository}`);
  if (input.text.trim().length > 0) terms.push(input.text.trim());
  terms.push("sort:updated-desc");
  return terms.join(" ");
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function normalizeIssue(node, host) {
  if (!isRecord(node)) throw fixedError("invalid-response", "Issue node is not an object");
  const repository = isRecord(node.repository)
    ? stringOrNull(node.repository.nameWithOwner)
      || (stringOrNull(node.repository.owner?.login) && stringOrNull(node.repository.name)
        ? `${node.repository.owner.login}/${node.repository.name}` : null)
    : null;
  const labels = Array.isArray(node.labels?.nodes)
    ? node.labels.nodes.filter(isRecord).map((label) => ({
      name: stringOrNull(label.name),
      color: stringOrNull(label.color),
      description: stringOrNull(label.description),
    })).filter((label) => label.name !== null)
    : [];
  const assignees = Array.isArray(node.assignees?.nodes)
    ? node.assignees.nodes.filter(isRecord).map((assignee) => stringOrNull(assignee.login)).filter(Boolean)
    : [];
  let milestone = null;
  if (isRecord(node.milestone)) {
    milestone = {
      title: stringOrNull(node.milestone.title),
      number: Number.isSafeInteger(node.milestone.number) ? node.milestone.number : null,
      state: stringOrNull(node.milestone.state),
      dueOn: stringOrNull(node.milestone.dueOn),
    };
  }
  return {
    id: stringOrNull(node.id),
    host,
    repository,
    number: Number.isSafeInteger(node.number) ? node.number : null,
    title: stringOrNull(node.title),
    url: stringOrNull(node.url),
    state: stringOrNull(node.state),
    stateReason: stringOrNull(node.stateReason),
    createdAt: stringOrNull(node.createdAt),
    updatedAt: stringOrNull(node.updatedAt),
    author: stringOrNull(node.author?.login),
    labels,
    assignees,
    milestone,
    commentCount: Number.isSafeInteger(node.comments?.totalCount) ? node.comments.totalCount : 0,
  };
}

function classifyMessage(message, fallback = "adapter-failed") {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (text.includes("not found") && (text.includes("gh") || text.includes("command"))) return "gh-missing";
  if (text.includes("rate limit") || text.includes("rate_limit") || text.includes("secondary rate")) return "rate-limited";
  if (text.includes("unauthorized") || text.includes("forbidden") || text.includes("permission") || text.includes("not accessible") || text.includes("http 401") || text.includes("http 403")) return "unauthorized";
  if (text.includes("not logged in") || text.includes("authentication") || text.includes("bad credentials")) return "auth-required";
  if (text.includes("network") || text.includes("offline") || text.includes("timed out") || text.includes("timeout") || text.includes("could not resolve")) return "offline";
  return fallback;
}

function classifyGraphQLErrors(errors) {
  if (!Array.isArray(errors)) return null;
  for (const error of errors) {
    const category = classifyMessage(error?.message, null);
    if (category) return category;
    if (error?.type === "RATE_LIMITED") return "rate-limited";
    if (error?.type === "FORBIDDEN" || error?.type === "UNAUTHORIZED") return "unauthorized";
  }
  return null;
}

function parseVersionLine(value) {
  if (typeof value !== "string") return null;
  const firstLine = value.split(/\r?\n/u, 1)[0];
  const match = firstLine.match(/^gh version (\d+)\.(\d+)\.(\d+)(?:\s.*)?$/u);
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

function isSupportedVersionText(versionText) {
  const parsed = parseVersionLine(versionText);
  if (parsed === null) return false;
  for (let index = 0; index < MIN_GH_VERSION.length; index += 1) {
    if (parsed[index] !== MIN_GH_VERSION[index]) return parsed[index] > MIN_GH_VERSION[index];
  }
  return true;
}

function spawnJson(commandArgs, deps = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const spawn = deps.spawn || defaultSpawn;
  const ghPath = deps.ghPath || "gh";
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    let stdout = "";
    let stderr = "";
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    try {
      child = spawn(ghPath, commandArgs, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      finish(reject, fixedError(error?.code === "ENOENT" ? "gh-missing" : "adapter-failed", error?.code === "ENOENT" ? "GitHub CLI is not installed" : "GitHub CLI could not be started"));
      return;
    }
    if (!child || !child.stdout || !child.stderr || !child.stdin || typeof child.on !== "function") {
      finish(reject, fixedError("adapter-failed", "GitHub CLI process is unavailable"));
      return;
    }
    timer = setTimeout(() => {
      finish(reject, fixedError("offline", "GitHub could not be reached"));
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(text, "utf8") > MAX_STDOUT_BYTES) {
        finish(reject, fixedError("invalid-response", "GitHub CLI response exceeded the output limit"));
        try { child.kill("SIGTERM"); } catch {}
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (Buffer.byteLength(stderr, "utf8") < MAX_STDERR_BYTES) {
        const room = MAX_STDERR_BYTES - Buffer.byteLength(stderr, "utf8");
        stderr += Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
      }
    });
    child.on("error", (error) => {
      finish(reject, fixedError(error?.code === "ENOENT" ? "gh-missing" : classifyMessage(error?.message), error?.code === "ENOENT" ? "GitHub CLI is not installed" : "GitHub CLI could not be started"));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const type = code === 4 ? "auth-required" : classifyMessage(stderr, commandArgs[0] === "auth" ? "auth-required" : "adapter-failed");
        finish(reject, fixedError(type, type === "auth-required" ? "GitHub CLI authentication is required" : type === "unauthorized" ? "GitHub authorization was denied" : type === "offline" ? "GitHub could not be reached" : type === "rate-limited" ? "GitHub API rate limit reached" : "GitHub CLI request failed"));
        return;
      }
      if (commandArgs[0] === "--version") {
        finish(resolve, { text: stdout });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish(reject, fixedError("invalid-response", "GitHub CLI returned invalid JSON"));
        return;
      }
      if (!isRecord(parsed)) {
        finish(reject, fixedError("invalid-response", "GitHub CLI returned an invalid response"));
        return;
      }
      finish(resolve, parsed);
    });
    try {
      if (commandArgs[0] === "api") {
        child.stdin.write(deps.stdinPayload || "");
      }
      child.stdin.end();
    } catch {
      finish(reject, fixedError("adapter-failed", "GitHub CLI input could not be sent"));
    }
  });
}

async function callGh(args, payload, deps, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return spawnJson(args, { ...deps, stdinPayload: payload === undefined ? undefined : JSON.stringify(payload) }, deps.timeoutMs || timeoutMs);
}

async function ensureGhVersion(deps) {
  const response = await callGh(["--version"], undefined, deps);
  if (!isSupportedVersionText(response.text)) throw fixedError("gh-upgrade-required", "GitHub CLI 2.81.0 or newer is required");
}

function authenticatedEntry(value) {
  return isRecord(value) && value.active === true && value.state === "success";
}

function authEntries(payload) {
  if (Array.isArray(payload?.hosts)) {
    return payload.hosts.filter(authenticatedEntry).map((value) => ({ host: value.host, value })).filter(({ host }) => typeof host === "string" && host.length > 0);
  }
  if (!isRecord(payload?.hosts)) return [];
  const entries = [];
  for (const [host, raw] of Object.entries(payload.hosts)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (!authenticatedEntry(value)) continue;
      entries.push({ host, value });
    }
  }
  return entries;
}

async function resolveHost(requestedHost, deps) {
  const status = await callGh(["auth", "status", "--json", "hosts"], undefined, deps);
  const entries = authEntries(status);
  if (entries.length === 0) throw fixedError("auth-required", "GitHub CLI authentication is required");
  if (requestedHost !== null) {
    const selected = entries.find(({ host }) => host === requestedHost);
    if (!selected) throw fixedError("auth-required", "The requested GitHub host is not authenticated");
    return selected.host;
  }
  const active = entries.find(({ value }) => value.active === true);
  if (active) return active.host;
  const authenticated = entries.find(({ value }) => authenticatedEntry(value));
  if (authenticated) return authenticated.host;
  throw fixedError("auth-required", "No active authenticated GitHub host is available");
}

function rateLimit(value) {
  if (!isRecord(value)) return { cost: null, remaining: null, resetAt: null };
  return {
    cost: Number.isSafeInteger(value.cost) ? value.cost : null,
    remaining: Number.isSafeInteger(value.remaining) ? value.remaining : null,
    resetAt: stringOrNull(value.resetAt),
  };
}

function warningList(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((error) => ({
    type: typeof error?.type === "string" ? error.type : "GRAPHQL_ERROR",
    path: Array.isArray(error?.path) ? error.path : [],
  }));
}

async function fetchCapabilities(host, deps) {
  const response = await callGh(["api", "graphql", "--hostname", host, "--input", "-"], { query: QUERIES.capabilities, variables: {} }, deps);
  const category = classifyGraphQLErrors(response.errors);
  if (!isRecord(response.data) || !isRecord(response.data.viewer) || typeof response.data.viewer.login !== "string" || response.data.viewer.login.length === 0) {
    throw fixedError(category || "invalid-response", category === "unauthorized" ? "GitHub authorization was denied" : "GitHub capabilities response is incomplete");
  }
  return {
    host,
    viewerLogin: response.data.viewer.login,
    rateLimit: rateLimit(response.data.rateLimit),
    ...(response.errors ? { warnings: warningList(response.errors) } : {}),
  };
}

async function listIssues(input, deps) {
  const host = await resolveHost(input.host, deps);
  const capabilities = await fetchCapabilities(host, deps);
  const search = buildSearchQuery(input, capabilities.viewerLogin);
  const response = await callGh(["api", "graphql", "--hostname", host, "--input", "-"], { query: QUERIES.list, variables: { search, cursor: input.cursor } }, deps);
  const category = classifyGraphQLErrors(response.errors);
  const searchData = response.data?.search;
  if (!isRecord(searchData) || !Array.isArray(searchData.nodes)) {
    throw fixedError(category || "invalid-response", category === "rate-limited" ? "GitHub API rate limit reached" : category === "unauthorized" ? "GitHub authorization was denied" : "GitHub Issues response is incomplete");
  }
  const pageInfo = isRecord(searchData.pageInfo) ? searchData.pageInfo : { hasNextPage: false, endCursor: null };
  const seen = new Set();
  const issues = [];
  for (const node of searchData.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || seen.has(node.id)) continue;
    seen.add(node.id);
    try { issues.push(normalizeIssue(node, host)); } catch {}
  }
  return {
    host,
    viewerLogin: capabilities.viewerLogin,
    issues,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage === true,
      endCursor: stringOrNull(pageInfo.endCursor),
    },
    rateLimit: rateLimit(response.data.rateLimit),
    warnings: warningList(response.errors),
  };
}

async function runOperation(envelope, deps = {}) {
  let normalized;
  try {
    normalized = validateEnvelope(envelope);
  } catch {
    throw fixedError("invalid-response", "Invalid adapter request");
  }
  await ensureGhVersion(deps);
  if (normalized.operation === "capabilities") return fetchCapabilities(await resolveHost(normalized.input.host, deps), deps);
  if (normalized.operation === "listIssues") return listIssues(normalized.input, deps);
  throw fixedError("adapter-failed", "Adapter operation is not available");
}

function responseFor(requestId, data, error) {
  return {
    version: 1,
    requestId,
    ok: error === null,
    data: error === null ? data : null,
    error,
  };
}

function safeRequestId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= LIMITS.requestId && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : "invalid-request";
}

async function runCli() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    process.stdout.write(`${JSON.stringify(responseFor("invalid-request", null, { code: "invalid-response", message: "Invalid adapter request" }))}\n`);
    return;
  }
  const requestId = safeRequestId(request?.requestId);
  try {
    const data = await runOperation(request);
    process.stdout.write(`${JSON.stringify(responseFor(requestId, data, null))}\n`);
  } catch (error) {
    const type = ["gh-missing", "gh-upgrade-required", "auth-required", "unauthorized", "offline", "rate-limited", "invalid-response", "adapter-failed"].includes(error?.type) ? error.type : "adapter-failed";
    const message = typeof error?.message === "string" && error.message.length <= 500 ? error.message : "GitHub Issues adapter failed";
    process.stdout.write(`${JSON.stringify(responseFor(requestId, null, { code: type, message }))}\n`);
  }
}

module.exports = {
  LIMITS,
  QUERIES,
  CAPABILITIES_QUERY,
  LIST_QUERY,
  buildSearchQuery,
  normalizeIssue,
  runOperation,
  AdapterError,
};

if (require.main === module) runCli().catch(() => {
  process.stdout.write(`${JSON.stringify(responseFor("invalid-request", null, { code: "adapter-failed", message: "GitHub Issues adapter failed" }))}\n`);
});
