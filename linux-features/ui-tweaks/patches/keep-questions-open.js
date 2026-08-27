"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findCodexRequestWebviewAsset } = require("../../../scripts/patches/lib/assets.js");
const { escapeRegExp, findMatchingBrace } = require("../../../scripts/patches/lib/minified-js.js");

const SETTING_KEY = "codex-linux-disable-request-user-input-auto-resolution";
const RUNTIME_MARKER = "codex-linux-disable-empty-user-input-auto-resolution";
const SETTINGS_MARKER = "codex-linux-revisions-settings";
const REVISION_DEFINITIONS = [
  ["composer.keepQuestionsOpen", "Keep questions open", "Wait for an explicit answer or interruption instead of automatically submitting an empty answer."],
  ["composer.skillMentionOrdering", "Order skill mentions", "Group namespaced skills together and sort matches by display name."],
  ["appearance.dockIcon", "Dock icon controls", "Expose and synchronize the ChatGPT Community dock and tray icon controls."],
  ["appearance.uiFontSize", "Extended UI font size", "Raise the upstream UI font-size limit to the configured Linux maximum."],
  ["home.suggestedPrompts", "Suggested prompts", "Expose the upstream Suggested Prompts control on Linux."],
  ["modelPicker.showModelsByDefault", "Show models by default", "Open the model picker with the complete model and reasoning controls visible."],
  ["reasoning.keepEffortLabelsEnglish", "English reasoning labels", "Keep reasoning-effort labels in English across localized interfaces."],
  ["sidebar.projectName", "Emphasize project names", "Apply the configured Linux project-name styling in the sidebar."],
];

function config(context) {
  const defaults = context?.feature?.manifest?.tweaks?.composer?.keepQuestionsOpen;
  const settings = context?.feature?.settings?.tweaks?.composer?.keepQuestionsOpen;
  return {
    ...(defaults != null && typeof defaults === "object" ? defaults : {}),
    ...(settings != null && typeof settings === "object" ? settings : {}),
  };
}

function enabled(context) {
  return config(context).enabled === true;
}

function revisionValues(context) {
  return Object.fromEntries(REVISION_DEFINITIONS.map(([key]) => {
    const [group, name] = key.split(".");
    const defaults = context?.feature?.manifest?.tweaks?.[group]?.[name];
    const settings = context?.feature?.settings?.tweaks?.[group]?.[name];
    return [key, settings?.enabled ?? defaults?.enabled ?? false];
  }));
}

function applyKeepQuestionsOpenPatch(source, context = {}) {
  if (!enabled(context) || typeof source !== "string") return source;
  if (source.includes(RUNTIME_MARKER)) return source;
  const pattern = /this\.trackRequest\(([\$A-Za-z_][\$A-Za-z0-9_]*),[^;]*?,`empty-user-input`\)/gu;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return source;
  return source.replace(pattern, `this.removePendingRequest($1)/*${RUNTIME_MARKER}*/`);
}

function applyKeepQuestionsOpenRuntimePatch(extractedDir, context = {}) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) return { matched: 0, changed: 0, reason: "main build directory is missing", targets: [] };
  const files = fs.readdirSync(buildDir).filter((name) => name.endsWith(".js"));
  const current = files.filter((name) => /this\.trackRequest\([^;]{0,300},`empty-user-input`\)/u.test(fs.readFileSync(path.join(buildDir, name), "utf8")));
  const patched = files.filter((name) => fs.readFileSync(path.join(buildDir, name), "utf8").includes(RUNTIME_MARKER));
  if (current.length === 0 && patched.length === 1) {
    return { matched: 1, changed: 0, reason: null, targets: [patched[0]] };
  }
  if (current.length !== 1 || patched.length !== 0) {
    return { matched: 0, changed: 0, reason: `found ${current.length} current and ${patched.length} patched timer owners`, targets: [] };
  }
  const target = path.join(buildDir, current[0]);
  const source = fs.readFileSync(target, "utf8");
  const output = applyKeepQuestionsOpenPatch(source, context);
  if (!output.includes(RUNTIME_MARKER)) {
    return { matched: 0, changed: 0, reason: "current timer registration did not match", targets: [] };
  }
  fs.writeFileSync(target, output);
  return { matched: 1, changed: 1, reason: null, targets: [current[0]] };
}

function settingsAliases(source, requestAsset) {
  const requestImport = source.match(
    new RegExp(`import\\{([^}]*)\\}from["']\\./${escapeRegExp(requestAsset.assetName)}["']`, "u"),
  )?.[1];
  const request = requestImport?.split(",").map((specifier) => specifier.trim()).map((specifier) => {
    const match = specifier.match(/^([^\s]+)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u);
    return match?.[1] === requestAsset.exportName ? (match[2] ?? match[1]) : null;
  }).find((value) => value != null);
  return {
    jsx: source.match(/function [A-Za-z_$][\w$]*\(\)\{[\s\S]{0,200}?\(0,([A-Za-z_$][\w$]*)\.jsx\)\([^)]*slug:`general-settings`/u)?.[1],
    react: source.match(/\b([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\(\),1\)/u)?.[1],
    group: source.match(/\.jsxs\)\(([A-Za-z_$][\w$]*),\{children:\[[^\]]*?\.jsx\)\(\1\.Content/u)?.[1],
    surface: source.match(/\.Content,\{children:\(0,[A-Za-z_$][\w$]*\.jsxs?\)\(([A-Za-z_$][\w$]*),\{children:/u)?.[1],
    row: source.match(/\.jsx\)\(([A-Za-z_$][\w$]*),\{label:[A-Za-z_$]/u)?.[1],
    toggle: source.match(/\.jsx\)\(([A-Za-z_$][\w$]*),\{checked:[^{}]{0,200}onChange:/u)?.[1],
    request,
  };
}

function applyKeepQuestionsOpenSettingsPatch(source, requestAsset, context = {}) {
  if (source.includes(SETTINGS_MARKER)) return source;
  const aliases = settingsAliases(source, requestAsset);
  if (Object.values(aliases).some((value) => value == null)) return source;
  const page = source.match(/function ([A-Za-z_$][\w$]*)\(\)\{[\s\S]{0,300}?slug:`general-settings`/u)?.[1];
  if (page == null) return source;
  const nextFunction = source.slice(source.indexOf(`function ${page}()`)).match(/\}\s*function ([A-Za-z_$][\w$]*)\(\)\{/u)?.[1];
  if (nextFunction == null) return source;
  const nextStart = source.indexOf(`function ${nextFunction}()`);
  const nextOpen = source.indexOf("{", nextStart);
  const nextClose = findMatchingBrace(source, nextOpen);
  if (nextClose === -1) return source;
  const body = source.slice(nextStart, nextClose + 1);
  const placement = new RegExp(
    `${escapeRegExp(aliases.jsx)}\\.Fragment,\\{children:\\[([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*),`,
    "u",
  );
  if (!placement.test(body)) return source;

  const { jsx, react, group, surface, row, toggle, request } = aliases;
  const fallback = JSON.stringify(revisionValues(context));
  const rows = REVISION_DEFINITIONS.map(([key, label, description]) =>
    `(0,${jsx}.jsx)(${row},{label:${JSON.stringify(label)},description:${JSON.stringify(description)},control:(0,${jsx}.jsx)(${toggle},{checked:e[${JSON.stringify(key)}]===!0,disabled:n||o,onChange:n=>l(${JSON.stringify(key)},n),ariaLabel:${JSON.stringify(label)}})})`,
  ).join(",");
  const component =
    `/*${SETTINGS_MARKER}*/function codexLinuxRevisionsSettings(){let[e,t]=(0,${react}.useState)(${fallback}),[n,r]=(0,${react}.useState)(!0),[i,a]=(0,${react}.useState)(null),[o,s]=(0,${react}.useState)(!1),[c,d]=(0,${react}.useState)(\`unavailable\`);` +
    `(0,${react}.useEffect)(()=>{let e=!0,b=window.electronBridge?.linuxRevisions?.request;return typeof b!==\`function\`?(a(\`Linux revisions bridge is unavailable.\`),r(!1),()=>{e=!1}):Promise.all([${request}(\`get-global-state\`,{params:{key:\`${SETTING_KEY}\`}}),b({operation:\`get\`})]).then(([n,i])=>{e&&(t({...i.tweaks,\`composer.keepQuestionsOpen\`:n?.value!==!1}),d(i.status),r(!1))}).catch(t=>{e&&(a(t instanceof Error?t.message:String(t)),r(!1))}),()=>{e=!1}},[]);` +
    `let l=(n,r)=>t(e=>({...e,[n]:r})),u=()=>{let n=window.electronBridge?.linuxRevisions?.request;if(typeof n!==\`function\`)return void a(\`Linux revisions bridge is unavailable.\`);s(!0),a(null),Promise.all([${request}(\`set-global-state\`,{params:{key:\`${SETTING_KEY}\`,value:e[\`composer.keepQuestionsOpen\`]}}),n({operation:\`apply\`,tweaks:e})]).then(()=>d(\`queued\`)).catch(e=>a(e instanceof Error?e.message:String(e))).finally(()=>s(!1))};` +
    `return(0,${jsx}.jsxs)(${group},{children:[(0,${jsx}.jsx)(${group}.Header,{title:\`Linux revisions\`}),(0,${jsx}.jsx)(${group}.Content,{children:(0,${jsx}.jsxs)(${surface},{children:[${rows},(0,${jsx}.jsx)(${row},{label:\`Apply revisions\`,description:i??(c===\`queued\`?\`Rebuild queued. It will install after ChatGPT Community closes.\`:\`Updater status: \`+c),control:(0,${jsx}.jsx)(\`button\`,{type:\`button\`,disabled:n||o,onClick:u,className:\`rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50\`,children:o?\`Queuing…\`:\`Apply and rebuild\`})})]})})]})}`;
  const patchedBody = body.replace(
    placement,
    `${jsx}.Fragment,{children:[$1,$2,(0,${jsx}.jsx)(codexLinuxRevisionsSettings,{}),`,
  );
  return `${source.slice(0, source.indexOf(`function ${page}()`))}${component}${source.slice(source.indexOf(`function ${page}()`), nextStart)}${patchedBody}${source.slice(nextClose + 1)}`;
}

function applyKeepQuestionsOpenAppPatch(extractedDir, context = {}) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) return { matched: 0, changed: 0, reason: "webview assets directory is missing", targets: [] };
  const names = fs.readdirSync(assetsDir).sort();
  const settingsMatches = names.filter((name) => /^general-settings-.*\.js$/.test(name) && fs.readFileSync(path.join(assetsDir, name), "utf8").includes("slug:`general-settings`"));
  if (settingsMatches.length !== 1) {
    return { matched: 0, changed: 0, reason: `found ${settingsMatches.length} settings assets`, targets: [] };
  }
  let requestAsset;
  try {
    requestAsset = findCodexRequestWebviewAsset(assetsDir);
  } catch (error) {
    return { matched: 0, changed: 0, reason: error.message, targets: [] };
  }
  const targets = [settingsMatches[0]];
  const originals = targets.map((name) => fs.readFileSync(path.join(assetsDir, name), "utf8"));
  const patched = originals.map((source) => applyKeepQuestionsOpenSettingsPatch(source, requestAsset, context));
  if (!patched[0].includes(SETTINGS_MARKER)) {
    return { matched: 0, changed: 0, reason: "current signed bundle seams did not match", targets: [] };
  }
  let changed = 0;
  patched.forEach((source, index) => {
    if (source === originals[index]) return;
    fs.writeFileSync(path.join(assetsDir, targets[index]), source, "utf8");
    changed += 1;
  });
  return { matched: targets.length, changed, reason: null, targets };
}

const descriptors = [
  {
    id: "keep-questions-open",
    phase: "extracted-app:pre-webview",
    order: 20_793,
    ciPolicy: "optional",
    enabled,
    apply: applyKeepQuestionsOpenRuntimePatch,
    status: (result) => result?.matched === 1
      ? (result.changed > 0 ? "applied" : "already-applied")
      : { status: "skipped-optional", reason: result?.reason ?? null },
  },
  {
    id: "linux-revisions-settings",
    phase: "extracted-app:post-webview",
    order: 20_794,
    ciPolicy: "optional",
    apply: applyKeepQuestionsOpenAppPatch,
    status: (result) => result?.matched === 1
      ? (result.changed > 0 ? "applied" : "already-applied")
      : { status: "skipped-optional", reason: result?.reason ?? null },
  },
];

module.exports = {
  RUNTIME_MARKER,
  SETTING_KEY,
  SETTINGS_MARKER,
  applyKeepQuestionsOpenAppPatch,
  applyKeepQuestionsOpenPatch,
  applyKeepQuestionsOpenRuntimePatch,
  applyKeepQuestionsOpenSettingsPatch,
  config,
  descriptors,
};
