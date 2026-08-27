#!/usr/bin/env node
"use strict";

const { execFile: defaultExecFile } = require("node:child_process");
const { promisify } = require("node:util");
const { validateEnvelope } = require("./protocol.js");

const LIST_QUERY = `query CodexLinuxIssues($search:String!,$cursor:String){search(query:$search,type:ISSUE,first:30,after:$cursor){nodes{... on Issue{id number title url state stateReason createdAt updatedAt bodyText author{login}repository{nameWithOwner}labels(first:12){nodes{name color}}assignees(first:10){nodes{login}}comments{totalCount}}}pageInfo{hasNextPage endCursor}}viewer{login}}`;
const DETAIL_QUERY = `query CodexLinuxIssue($nodeId:ID!){node(id:$nodeId){... on Issue{id number title url state stateReason createdAt updatedAt body author{login}repository{nameWithOwner}labels(first:20){nodes{name color}}assignees(first:20){nodes{login}}comments(first:50){nodes{id body createdAt author{login}}totalCount}}}}`;

function buildSearchQuery({ view, state, repository, query }, login) {
  const terms = ["is:issue", state === "all" ? null : `is:${state}`];
  if (view === "assigned") terms.push(`assignee:${login}`);
  else if (view === "authored") terms.push(`author:${login}`);
  else terms.push(`involves:${login}`);
  if (repository) terms.push(`repo:${repository}`);
  if (query.trim()) terms.push(query.trim());
  terms.push("sort:updated-desc");
  return terms.filter(Boolean).join(" ");
}

function authEntries(payload) {
  const hosts = payload?.hosts && typeof payload.hosts === "object" ? payload.hosts : {};
  return Object.entries(hosts).flatMap(([host, raw]) => (Array.isArray(raw) ? raw : [raw])
    .filter((entry) => entry?.active === true && entry?.state === "success")
    .map((entry) => ({ host, login: entry.login })));
}

function normalizeIssue(node) {
  return {
    id: node.id, number: node.number, title: node.title, url: node.url,
    state: node.state, stateReason: node.stateReason ?? null,
    createdAt: node.createdAt, updatedAt: node.updatedAt,
    body: node.body ?? node.bodyText ?? "", author: node.author?.login ?? null,
    repository: node.repository?.nameWithOwner ?? null,
    labels: (node.labels?.nodes ?? []).map(({ name, color }) => ({ name, color })),
    assignees: (node.assignees?.nodes ?? []).map(({ login }) => login),
    commentCount: node.comments?.totalCount ?? 0,
    comments: (node.comments?.nodes ?? []).map((comment) => ({
      id: comment.id, body: comment.body, createdAt: comment.createdAt, author: comment.author?.login ?? null,
    })),
  };
}

function errorMessage(error) {
  const raw = String(error?.stderr || error?.message || "GitHub request failed").trim();
  return raw.split(/\r?\n/u).filter(Boolean).at(-1)?.slice(0, 500) || "GitHub request failed";
}

function classify(error) {
  const message = errorMessage(error).toLowerCase();
  if (error?.code === "ENOENT") return "gh-missing";
  if (message.includes("authentication") || message.includes("not logged")) return "auth-required";
  if (message.includes("could not resolve") || message.includes("network") || message.includes("timed out")) return "offline";
  if (message.includes("rate limit")) return "rate-limited";
  if (message.includes("forbidden") || message.includes("unauthorized")) return "unauthorized";
  return "adapter-failed";
}

function createAdapter({ execFile = defaultExecFile } = {}) {
  const run = promisify(execFile);
  const gh = async (args) => JSON.parse((await run("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })).stdout);
  const graphql = (host, query, fields) => gh(["api", "graphql", "--hostname", host, "-f", `query=${query}`, ...Object.entries(fields).flatMap(([key, value]) => value == null ? [] : ["-F", `${key}=${value}`])]);
  return async function operate(envelope) {
    const request = validateEnvelope(envelope);
    const entries = authEntries(await gh(["auth", "status", "--json", "hosts"]));
    const selected = request.input.host == null ? entries[0] : entries.find(({ host }) => host === request.input.host);
    if (!selected) throw Object.assign(new Error("No authenticated GitHub host was found"), { type: "auth-required" });
    if (request.operation === "capabilities") {
      const result = await graphql(selected.host, "query{viewer{login}}", {});
      return { host: selected.host, login: result.data?.viewer?.login ?? selected.login };
    }
    if (request.operation === "listIssues") {
      const search = buildSearchQuery(request.input, selected.login);
      const result = await graphql(selected.host, LIST_QUERY, { search, cursor: request.input.cursor });
      if (!Array.isArray(result.data?.search?.nodes)) throw new Error(result.errors?.[0]?.message || "GitHub Issues response was incomplete");
      return { host: selected.host, login: result.data.viewer?.login ?? selected.login, issues: result.data.search.nodes.filter(Boolean).map(normalizeIssue), pageInfo: result.data.search.pageInfo };
    }
    if (request.operation === "getIssue") {
      const result = await graphql(selected.host, DETAIL_QUERY, { nodeId: request.input.nodeId });
      if (!result.data?.node?.id) throw new Error(result.errors?.[0]?.message || "GitHub Issue was not found");
      return { issue: normalizeIssue(result.data.node) };
    }
    throw new Error("Unsupported operation");
  };
}

function response(requestId, data, error) {
  return { version: 1, requestId, ok: error == null, data: error == null ? data : null, error };
}

async function runCli() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { request = {}; }
  const requestId = typeof request.requestId === "string" ? request.requestId : "invalid-request";
  try {
    process.stdout.write(`${JSON.stringify(response(requestId, await createAdapter()(request), null))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(response(requestId, null, { code: error.type || classify(error), message: errorMessage(error) }))}\n`);
  }
}

if (require.main === module) runCli();

module.exports = { DETAIL_QUERY, LIST_QUERY, authEntries, buildSearchQuery, classify, createAdapter, normalizeIssue };
