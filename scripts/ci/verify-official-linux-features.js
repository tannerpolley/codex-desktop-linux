#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  discoverLinuxFeatureManifests,
  loadLinuxFeaturePatchDescriptors,
} = require("../lib/linux-features.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../lib/patch-report.js");
const { patchExtractedApp } = require("../patches/runner.js");
const { verifyAppProtocolImports, verifyPatchedModuleSyntax } = require("./app-protocol-imports.js");

const source = process.argv[2];
if (!source || !fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("Usage: verify-official-linux-features.js <extracted-official-app-asar>");
  process.exit(2);
}

const featuresRoot = path.resolve(__dirname, "../../linux-features");
const features = discoverLinuxFeatureManifests({ featuresRoot });
const featureMap = new Map(features.map((feature) => [feature.id, feature]));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-feature-audit-"));
const failures = [];
let audited = 0;

try {
  for (const feature of features) {
    const enabled = [];
    const addWithRequirements = (id) => {
      if (enabled.includes(id)) return;
      const current = featureMap.get(id);
      if (current == null) throw new Error(`Missing required feature ${id}`);
      for (const required of current.manifest.requires) addWithRequirements(required);
      enabled.push(id);
    };
    addWithRequirements(feature.id);
    const internalFeatureIds = enabled.filter((id) => featureMap.get(id)?.manifest.internal === true);
    const config = path.join(work, `${feature.id}.json`);
    fs.writeFileSync(config, `${JSON.stringify({ enabled })}\n`);
    const descriptors = loadLinuxFeaturePatchDescriptors({
      featuresRoot,
      featuresConfigPath: config,
      internalFeatureIds,
    });
    if (!descriptors.some((descriptor) => descriptor.featureId === feature.id)) continue;

    const app = path.join(work, feature.id);
    fs.cpSync(source, app, { recursive: true, verbatimSymlinks: true });
    const report = createPatchReport();
    patchExtractedApp(app, {
      report,
      featuresRoot,
      featuresConfigPath: config,
      internalFeatureIds,
    });
    verifyAppProtocolImports(app);
    verifyPatchedModuleSyntax(app);
    if (feature.id === "ui-tweaks" && process.env.CODEX_ELECTRON_ACCEPTANCE === "1") {
      const profile = path.join(work, "settings-electron-profile");
      const acceptance = spawnSync("xvfb-run", ["-a", "npm", "run", "test:settings-ui", "--", "--ozone-platform=x11", "--disable-gpu"], {
        cwd: path.resolve(__dirname, "../.."),
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CODEX_EXTRACTED_APP_DIR: app,
          XDG_CACHE_HOME: path.join(profile, "cache"),
          XDG_CONFIG_HOME: path.join(profile, "config"),
          XDG_STATE_HOME: path.join(profile, "state"),
        },
      });
      if (acceptance.status !== 0) throw new Error(`Settings Electron acceptance failed:\n${acceptance.stdout}${acceptance.stderr}`);
      console.log(acceptance.stdout.trim());
    }
    const featureFailures = enabledFeatureFailuresFromReport(report);
    audited += 1;
    if (featureFailures.length > 0) {
      failures.push({ featureId: feature.id, failures: featureFailures });
    }
    fs.rmSync(app, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Feature drift: ${failure.featureId}`);
    for (const entry of failure.failures) {
      console.error(`  ${entry.name}: ${entry.status}${entry.reason ? ` — ${entry.reason}` : ""}`);
    }
  }
  process.exit(1);
}

console.log(`Official Linux feature audit passed: ${audited} ASAR feature(s)`);
