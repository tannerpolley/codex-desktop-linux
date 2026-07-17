"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  applyMainBridgePatch,
  applyPreloadBridgePatch,
} = require("./bridge-source.js");

function walkJavaScriptFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(entryPath);
      }
    }
  };
  walk(root);
  return files;
}

function patchPreloadBridgeAssets(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  try {
    const candidates = walkJavaScriptFiles(buildDir).filter((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return source.includes("exposeInMainWorld") && source.includes("electronBridge");
    });
    if (candidates.length !== 1) {
      const reason = candidates.length === 0
        ? `no electronBridge preload bundle found under ${buildDir}`
        : `found ${candidates.length} electronBridge preload bundles under ${buildDir}`;
      console.warn(`WARN: ${reason} - skipping GitHub Issues preload bridge patch`);
      return { matched: false, changed: 0, reason };
    }
    const filePath = candidates[0];
    const source = fs.readFileSync(filePath, "utf8");
    const patched = applyPreloadBridgePatch(source);
    if (patched === source) {
      if (!source.includes("githubIssues:{request:e=>")) {
        const reason = "electronBridge preload anchor did not match the current shape";
        console.warn(`WARN: ${reason} - skipping GitHub Issues preload bridge patch`);
        return { matched: false, changed: 0, reason };
      }
      return { matched: true, changed: 0 };
    }
    fs.writeFileSync(filePath, patched, "utf8");
    return { matched: true, changed: 1 };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`WARN: GitHub Issues preload bridge patch skipped: ${reason}`);
    return { matched: false, changed: 0, reason };
  }
}

function optionalDriftStatus(result, warnings) {
  if (result?.matched === false) {
    return { status: "skipped-optional", reason: result.reason ?? warnings[0] ?? null };
  }
  return (result?.changed ?? 0) > 0 ? "applied" : "already-applied";
}

const descriptors = [
  {
    id: "github-issues-main-bridge",
    phase: "main-bundle",
    order: 20_930,
    ciPolicy: "optional",
    apply: applyMainBridgePatch,
  },
  {
    id: "github-issues-preload-bridge",
    phase: "extracted-app:post-webview",
    order: 20_931,
    ciPolicy: "optional",
    apply: patchPreloadBridgeAssets,
    status: optionalDriftStatus,
  },
];

module.exports = {
  descriptors,
  applyMainBridgePatch,
  patchPreloadBridgeAssets,
  optionalDriftStatus,
  walkJavaScriptFiles,
};
