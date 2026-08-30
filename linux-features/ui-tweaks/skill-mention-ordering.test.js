#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const featureManifest = require("./feature.json");
const {
  RUNTIME_MARKER,
  applySkillMentionOrderingAppPatch,
  applySkillMentionOrderingPatch,
  descriptors,
} = require("./patches/skill-mention-ordering.js");

function fixtureSource() {
  return [
    "function v1a(e,t){let n=t.trim();if(n.length===0)return e;let r=pU(n);return(0,x1a.default)(e.map((e,t)=>({item:e,score:y1a(e,r),index:t})),[e=>-e.score,e=>e.item.displayName,e=>e.index]).filter(e=>e.score>0).map(e=>e.item)}",
    "function y1a(e,t){return Math.max(t(e.name),t(e.displayName),t(e.path))}",
    "function p1a(){return `composer.skillMentionList.noResults`}",
  ].join("");
}

function enabledContext() {
  return {
    feature: {
      manifest: featureManifest,
      settings: { tweaks: { composer: { skillMentionOrdering: { enabled: true } } } },
    },
  };
}

function createExtractedApp(sources = [fixtureSource()]) {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-mention-ordering-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  sources.forEach((source, index) => {
    fs.writeFileSync(path.join(assetsDir, `app-initial-${index}.js`), source);
  });
  return { extractedDir, assetsDir };
}

test("skill mention ordering is independently disabled by default", () => {
  assert.equal(featureManifest.tweaks.composer.skillMentionOrdering.enabled, false);
  assert.equal(applySkillMentionOrderingPatch(fixtureSource(), { feature: { manifest: featureManifest } }), fixtureSource());
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].enabled({ feature: { manifest: featureManifest } }), false);
  assert.equal(descriptors[0].enabled(enabledContext()), true);
});

test("namespace matches share one score tier and sort by display name", () => {
  const source = fixtureSource();
  const patched = applySkillMentionOrderingPatch(source, enabledContext());
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.equal(applySkillMentionOrderingPatch(patched, enabledContext()), patched);
  assert.doesNotThrow(() => new vm.Script(patched));

  const context = {
    pU: (query) => (value) => value.toLowerCase().startsWith(query.toLowerCase()) ? 100 - value.length : 0,
    x1a: {
      default(items, iteratees) {
        return items.sort((left, right) => {
          for (const iteratee of iteratees) {
            const difference = iteratee(left) < iteratee(right) ? -1 : iteratee(left) > iteratee(right) ? 1 : 0;
            if (difference !== 0) return difference;
          }
          return 0;
        });
      },
    },
  };
  vm.runInNewContext(`${patched}\nthis.rank=v1a;`, context);
  const ranked = context.rank([
    { name: "cse:long-name", displayName: "C Display", path: "skills/cse/long" },
    { name: "cse:x", displayName: "A Display", path: "skills/cse/x" },
    { name: "cse:medium", displayName: "B Display", path: "skills/cse/medium" },
    { name: "other", displayName: "Z External", path: "skills/other" },
  ], "cse");
  assert.deepEqual(ranked.map(({ name }) => name), ["cse:x", "cse:medium", "cse:long-name"]);
});

test("app patch is transactional, idempotent, and rejects ambiguity", () => {
  const fixture = createExtractedApp();
  try {
    assert.deepEqual(applySkillMentionOrderingAppPatch(fixture.extractedDir, enabledContext()), {
      matched: 1,
      changed: 1,
      reason: null,
      target: "app-initial-0.js",
    });
    assert.deepEqual(applySkillMentionOrderingAppPatch(fixture.extractedDir, enabledContext()), {
      matched: 1,
      changed: 0,
      reason: null,
      target: "app-initial-0.js",
    });
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }

  const ambiguous = createExtractedApp([fixtureSource(), fixtureSource()]);
  try {
    const before = fs.readdirSync(ambiguous.assetsDir).map((name) => [
      name,
      fs.readFileSync(path.join(ambiguous.assetsDir, name), "utf8"),
    ]);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    let result;
    try {
      result = applySkillMentionOrderingAppPatch(ambiguous.extractedDir, enabledContext());
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.matched, 0);
    assert.equal(result.changed, 0);
    assert.equal(warnings.length, 1);
    for (const [name, source] of before) {
      assert.equal(fs.readFileSync(path.join(ambiguous.assetsDir, name), "utf8"), source);
    }
  } finally {
    fs.rmSync(ambiguous.extractedDir, { recursive: true, force: true });
  }
});

test("matches the current signed skill mention bundle when provided", { skip: process.env.CODEX_OFFICIAL_EXTRACTED_DIR == null }, () => {
  const assetsDir = path.join(process.env.CODEX_OFFICIAL_EXTRACTED_DIR, "webview", "assets");
  const name = fs.readdirSync(assetsDir).find((entry) => /^app-initial-[^.]+\.js$/.test(entry)
    && fs.readFileSync(path.join(assetsDir, entry), "utf8").includes("composer.skillMentionList.noResults"));
  assert.ok(name);
  const fixture = createExtractedApp([fs.readFileSync(path.join(assetsDir, name), "utf8")]);
  try {
    const result = applySkillMentionOrderingAppPatch(fixture.extractedDir, enabledContext());
    assert.equal(result.matched, 1, JSON.stringify(result));
    assert.equal(result.changed, 1);
    assert.match(fs.readFileSync(path.join(fixture.assetsDir, "app-initial-0.js"), "utf8"), new RegExp(RUNTIME_MARKER));
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});
