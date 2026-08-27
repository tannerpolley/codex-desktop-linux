#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { missingAppProtocolImports, staticAppImports, verifyAppProtocolImports } = require("./app-protocol-imports.js");

test("static app imports include literal root imports only", () => {
  assert.deepEqual(staticAppImports("import('/feature.mjs');import(`./local.js`);import(`/skip-${name}.js`)"), ["/feature.mjs"]);
});

test("app protocol closure fails until every imported module is in the webview root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-imports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const webview = path.join(root, "webview");
  fs.mkdirSync(path.join(webview, "assets"), { recursive: true });
  fs.writeFileSync(path.join(webview, "assets", "entry.js"), "import('/feature.mjs')\n");

  assert.deepEqual(missingAppProtocolImports(root), [{ importer: "webview/assets/entry.js", specifier: "/feature.mjs" }]);
  assert.throws(() => verifyAppProtocolImports(root), /Unresolved static app:\/\/ imports/);

  fs.writeFileSync(path.join(webview, "feature.mjs"), "export const ready = true;\n");
  assert.doesNotThrow(() => verifyAppProtocolImports(root));
});
