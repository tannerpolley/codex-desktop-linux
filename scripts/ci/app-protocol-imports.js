#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function walkModules(root) {
  const modules = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) modules.push(target);
    }
  };
  visit(root);
  return modules;
}

function staticAppImports(source) {
  const imports = [];
  for (const match of source.matchAll(/\bimport\s*\(\s*(["'`])([^"'`$]+)\1\s*\)/gu)) {
    if (match[2].startsWith("/")) imports.push(match[2]);
  }
  return imports;
}

function missingAppProtocolImports(extractedAppDir) {
  const webviewRoot = path.join(path.resolve(extractedAppDir), "webview");
  if (!fs.statSync(webviewRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Missing extracted webview root: ${webviewRoot}`);
  }
  const missing = [];
  for (const modulePath of walkModules(webviewRoot)) {
    const source = fs.readFileSync(modulePath, "utf8");
    for (const specifier of staticAppImports(source)) {
      const pathname = new URL(specifier, "app://-").pathname;
      const resolved = path.resolve(webviewRoot, `.${decodeURIComponent(pathname)}`);
      if (!resolved.startsWith(`${webviewRoot}${path.sep}`) || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
        missing.push({ importer: path.relative(extractedAppDir, modulePath), specifier });
      }
    }
  }
  return missing;
}

function verifyAppProtocolImports(extractedAppDir) {
  const missing = missingAppProtocolImports(extractedAppDir);
  if (missing.length > 0) {
    throw new Error(`Unresolved static app:// imports:\n${missing.map(({ importer, specifier }) => `  ${importer}: ${specifier}`).join("\n")}`);
  }
}

if (require.main === module) {
  const extractedAppDir = process.argv[2];
  if (!extractedAppDir) {
    console.error("Usage: app-protocol-imports.js <extracted-app-asar-dir>");
    process.exit(2);
  }
  verifyAppProtocolImports(extractedAppDir);
  console.log("Static app:// import closure passed");
}

module.exports = { missingAppProtocolImports, staticAppImports, verifyAppProtocolImports };
