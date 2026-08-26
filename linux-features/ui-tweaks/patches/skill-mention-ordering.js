"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKILL_MENTION_ASSET_PATTERN = /^app-initial-[^.]+\.js$/;
const RUNTIME_MARKER = "codex-linux-skill-mention-namespace-order";

function warn(message) {
  console.warn(`WARN: ${message} - skipping ui-tweaks skill mention ordering patch`);
}

function skillMentionOrderingConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.composer?.skillMentionOrdering;
  const settings = context?.feature?.settings?.tweaks?.composer?.skillMentionOrdering;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function enabled(context) {
  return skillMentionOrderingConfig(context).enabled === true;
}

function findFunctionRange(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0 || source.indexOf(`function ${name}(`, start + 1) >= 0) return null;
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote != null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "`" || character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return { start, end: index + 1 };
  }
  return null;
}

function applySkillMentionOrderingPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || source.includes(RUNTIME_MARKER)) return source;

    const range = findFunctionRange(source, "v1a");
    if (range == null) {
      if (context.warnOnMissingMarkers === true) warn("Current ranking function was not unique");
      return source;
    }
    const body = source.slice(range.start, range.end);
    if (
      !body.includes("function v1a(e,t){") ||
      !body.includes("let r=pU(n)") ||
      !body.includes("y1a(e,r)") ||
      !body.includes("e.item.displayName")
    ) {
      if (context.warnOnMissingMarkers === true) warn("Current ranking anchors did not match");
      return source;
    }

    const replacement =
      "function v1a(e,t){let n=t.trim();if(n.length===0)return e;" +
      "let r=pU(n),i=e.map((e,t)=>({item:e,score:y1a(e,r),index:t}))," +
      "a=n.toLowerCase(),o=a.indexOf(`:`)<0?i.filter(e=>typeof e.item.name===`string`" +
      "&&e.item.name.toLowerCase().startsWith(`${a}:`)):[]," +
      "s=o.length>0?Math.max(...o.map(e=>e.score)):null;" +
      "s!=null&&(i=i.map(e=>o.includes(e)?{...e,score:s}:e));" +
      "return(0,x1a.default)(i,[e=>-e.score,e=>e.item.displayName,e=>e.index])" +
      `.filter(e=>e.score>0).map(e=>e.item)}/*${RUNTIME_MARKER}*/`;
    return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function findSkillMentionBundle(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) return { candidate: null, reason: "Webview assets directory is missing" };
  const candidates = fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SKILL_MENTION_ASSET_PATTERN.test(entry.name))
    .map((entry) => {
      const filePath = path.join(assetsDir, entry.name);
      return { filePath, name: entry.name, source: fs.readFileSync(filePath, "utf8") };
    })
    .filter(({ source }) =>
      source.includes("composer.skillMentionList.noResults") &&
      (source.includes("function v1a(") || source.includes(RUNTIME_MARKER)),
    );
  if (candidates.length !== 1) {
    return {
      candidate: null,
      reason: `Found ${candidates.length} current skill mention ranking bundles`,
    };
  }
  return { candidate: candidates[0], reason: null };
}

function applySkillMentionOrderingAppPatch(extractedDir, context = {}) {
  const discovery = findSkillMentionBundle(extractedDir);
  if (discovery.candidate == null) {
    warn(discovery.reason);
    return { matched: 0, changed: 0, reason: discovery.reason };
  }
  const { filePath, name, source } = discovery.candidate;
  const patched = applySkillMentionOrderingPatch(source, {
    ...context,
    warnOnMissingMarkers: true,
  });
  if (patched === source) {
    if (source.includes(RUNTIME_MARKER)) {
      return { matched: 1, changed: 0, reason: null, target: name };
    }
    const reason = "Current skill mention ranking bundle could not be patched";
    return { matched: 0, changed: 0, reason };
  }
  fs.writeFileSync(filePath, patched, "utf8");
  return { matched: 1, changed: 1, reason: null, target: name };
}

const descriptors = [
  {
    id: "skill-mention-namespace-order",
    phase: "extracted-app:post-webview",
    order: 20_793,
    ciPolicy: "optional",
    enabled,
    apply: applySkillMentionOrderingAppPatch,
    status: (result, warnings) => {
      if (result?.matched !== 1) {
        return { status: "skipped-optional", reason: result?.reason ?? warnings[0] ?? null };
      }
      return result.changed > 0 ? "applied" : "already-applied";
    },
  },
];

module.exports = {
  RUNTIME_MARKER,
  SKILL_MENTION_ASSET_PATTERN,
  applySkillMentionOrderingAppPatch,
  applySkillMentionOrderingPatch,
  descriptors,
  findSkillMentionBundle,
  skillMentionOrderingConfig,
};
