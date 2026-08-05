"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const previewDir = path.join(repoRoot, "linux-features", "local", "github-issues-tab", "preview");
const index = fs.readFileSync(path.join(previewDir, "index.html"), "utf8");
const fixtures = fs.readFileSync(path.join(previewDir, "fixtures.mjs"), "utf8");
const server = fs.readFileSync(path.join(repoRoot, "scripts", "dev", "github-issues-preview.sh"), "utf8");

test("GitHub Issues browser preview reuses the renderer with fixture bridge data", () => {
  assert.match(index, /createIssuesSidePanel/);
  assert.match(index, /window\.electronBridge/);
  assert.match(index, /PreviewMarkdown/);
  assert.match(index, /Repository fixture:/);
  assert.match(index, /click a card to expand it inline/);
  assert.match(fixtures, /export const issues/);
  assert.equal((fixtures.match(/^    id: "preview-issue-\d+",$/gm) || []).length, 4);
  assert.match(server, /python3 -m http\.server/);
  assert.match(server, /CODEX_ISSUES_PREVIEW_PORT/);
});
