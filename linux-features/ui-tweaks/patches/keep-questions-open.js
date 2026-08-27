"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findCodexRequestWebviewAsset } = require("../../../scripts/patches/lib/assets.js");
const { escapeRegExp, findMatchingBrace } = require("../../../scripts/patches/lib/minified-js.js");

const SETTING_KEY = "codex-linux-disable-request-user-input-auto-resolution";
const RUNTIME_MARKER = "codex-linux-keep-questions-open";
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

function functionRanges(source) {
  const ranges = [];
  const pattern = /function [A-Za-z_$][\w$]*\([^)]*\)\{/gu;
  let match;
  while ((match = pattern.exec(source)) != null) {
    const open = source.indexOf("{", match.index);
    const close = findMatchingBrace(source, open);
    if (close !== -1) ranges.push({ start: match.index, end: close + 1 });
  }
  return ranges;
}

function globalStateHook(source) {
  const atom = source.match(
    /`get-global-state`,[\s\S]{0,800}?\}\)\),([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(/u,
  )?.[1];
  if (atom == null) return null;
  return source.match(
    new RegExp(
      `function ([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*)\\)\\{return [A-Za-z_$][\\w$]*\\(${escapeRegExp(atom)},\\2\\)\\}`,
      "u",
    ),
  )?.[1] ?? null;
}

function reactAliasAfter(source, offset) {
  const tail = source.slice(offset, offset + 32768);
  return tail.match(/\b([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\(\),1\)/u)?.[1] ?? null;
}

function patchStructuredQuestionFunction(source, hook) {
  for (const range of functionRanges(source)) {
    const original = source.slice(range.start, range.end);
    if (
      !original.includes("requestUserInputAutoResolution.snooze") ||
      !original.includes("autoResolution:") ||
      !original.includes("onUserInteraction:") ||
      !original.includes("forceOtherOption") ||
      !original.includes("replyWithEmptyResponseOnDismiss") ||
      original.includes(RUNTIME_MARKER)
    ) continue;

    const state = original.match(
      /([;,])([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\?\.requestId===([A-Za-z_$][\w$]*)\.requestId\?\3:null([,;])/u,
    );
    const argument = original.match(/^function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\)\{/u)?.[1];
    const context = state == null || argument == null ? null : original.slice(0, state.index).match(
      new RegExp(`\\{([^{}]*\\bconversationId:[^{}]*\\bhostId:[^{}]*)\\}=${escapeRegExp(argument)}[,;]`, "u"),
    )?.[1];
    const conversation = context?.match(/\bconversationId:([A-Za-z_$][\w$]*)/u)?.[1];
    const host = context?.match(/\bhostId:([A-Za-z_$][\w$]*)/u)?.[1];
    const react = reactAliasAfter(source, range.end);
    const action = original.match(/([A-Za-z_$][\w$]*)\.requestUserInputAutoResolution\.snooze/u)?.[1];
    if (state == null || conversation == null || host == null || react == null || action == null) continue;

    const [, , pending, , request, delimiter] = state;
    const declaration =
      `let codexLinuxKeepQuestionsOpen=${hook}(\`${SETTING_KEY}\`)?.data!==!1;` +
      `(0,${react}.useEffect)(()=>{if(!codexLinuxKeepQuestionsOpen||${pending}==null||${pending}.resolutionState.status===\`snoozed\`)return;` +
      `${action}.requestUserInputAutoResolution.snooze({conversationId:${conversation},hostId:${host},requestId:${request}.requestId})},` +
      `[${conversation},${host},${request}.requestId,${pending},codexLinuxKeepQuestionsOpen]);/*${RUNTIME_MARKER}*/`;
    let patched;
    if (delimiter === ",") {
      const end = state.index + state[0].length - 1;
      patched = `${original.slice(0, end)};${declaration}let ${original.slice(end + 1)}`;
    } else {
      const end = original.indexOf(";", state.index);
      if (end === -1) continue;
      patched = `${original.slice(0, end + 1)}${declaration}${original.slice(end + 1)}`;
    }
    patched = patched
      .replace(
        new RegExp(`${escapeRegExp(pending)}(?:\\?\\.|\\.)resolutionState\\.status===\`scheduled\`\\?`, "gu"),
        "!codexLinuxKeepQuestionsOpen&&$&",
      )
      .replace(
        new RegExp(`${escapeRegExp(pending)}!=null&&${escapeRegExp(pending)}\\.resolutionState\\.status!==\`snoozed\`\\?`, "gu"),
        "!codexLinuxKeepQuestionsOpen&&$&",
      );
    return source.replace(original, patched);
  }
  return source;
}

function patchTaskRow(source, hook) {
  for (const range of functionRanges(source)) {
    const original = source.slice(range.start, range.end);
    if (
      !original.includes("snoozeInputTimeout") ||
      !original.includes("requestUserInputAutoResolution.snooze") ||
      original.includes(RUNTIME_MARKER)
    ) continue;
    const scheduled = /([A-Za-z_$][\w$]*)\?\.resolutionState\.status===`scheduled`\?/gu;
    if (!scheduled.test(original)) continue;
    scheduled.lastIndex = 0;
    const open = original.indexOf("{");
    const patched = `${original.slice(0, open + 1)}let codexLinuxKeepQuestionsOpen=${hook}(\`${SETTING_KEY}\`)?.data!==!1;/*${RUNTIME_MARKER}*/${original.slice(open + 1)}`
      .replace(scheduled, "!codexLinuxKeepQuestionsOpen&&$1?.resolutionState.status===`scheduled`?");
    return source.replace(original, patched);
  }
  return source;
}

function applyKeepQuestionsOpenPatch(source, context = {}) {
  if (!enabled(context) || typeof source !== "string") return source;
  const hook = globalStateHook(source);
  if (hook == null) return source;
  return patchTaskRow(patchStructuredQuestionFunction(source, hook), hook);
}

function settingsAliases(source) {
  return {
    jsx: source.match(/function [A-Za-z_$][\w$]*\(\)\{[\s\S]{0,200}?\(0,([A-Za-z_$][\w$]*)\.jsx\)\([^)]*slug:`general-settings`/u)?.[1],
    react: source.match(/\b([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\(\),1\)/u)?.[1],
    group: source.match(/\.jsxs\)\(([A-Za-z_$][\w$]*),\{children:\[[^\]]*?\.jsx\)\(\1\.Content/u)?.[1],
    surface: source.match(/\.Content,\{children:\(0,[A-Za-z_$][\w$]*\.jsxs?\)\(([A-Za-z_$][\w$]*),\{children:/u)?.[1],
    row: source.match(/\.jsx\)\(([A-Za-z_$][\w$]*),\{label:[A-Za-z_$]/u)?.[1],
    toggle: source.match(/\.jsx\)\(([A-Za-z_$][\w$]*),\{checked:[^{}]{0,200}onChange:/u)?.[1],
  };
}

function applyKeepQuestionsOpenSettingsPatch(source, requestAsset, context = {}) {
  if (source.includes(SETTINGS_MARKER)) return source;
  const aliases = settingsAliases(source);
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

  const { jsx, react, group, surface, row, toggle } = aliases;
  const request = `import(\"./${requestAsset.assetName}\").then(e=>e.${requestAsset.exportName}`;
  const fallback = JSON.stringify(revisionValues(context));
  const rows = REVISION_DEFINITIONS.map(([key, label, description]) =>
    `(0,${jsx}.jsx)(${row},{label:${JSON.stringify(label)},description:${JSON.stringify(description)},control:(0,${jsx}.jsx)(${toggle},{checked:e[${JSON.stringify(key)}]===!0,disabled:n||o,onChange:n=>l(${JSON.stringify(key)},n),ariaLabel:${JSON.stringify(label)}})})`,
  ).join(",");
  const component =
    `/*${SETTINGS_MARKER}*/function codexLinuxRevisionsSettings(){let[e,t]=(0,${react}.useState)(${fallback}),[n,r]=(0,${react}.useState)(!0),[i,a]=(0,${react}.useState)(null),[o,s]=(0,${react}.useState)(!1),[c,d]=(0,${react}.useState)(\`unavailable\`);` +
    `(0,${react}.useEffect)(()=>{let e=!0,b=window.electronBridge?.linuxRevisions?.request;return typeof b!==\`function\`?(a(\`Linux revisions bridge is unavailable.\`),r(!1),()=>{e=!1}):Promise.all([${request}(\`get-global-state\`,{params:{key:\`${SETTING_KEY}\`}})),b({operation:\`get\`})]).then(([n,i])=>{e&&(t({...i.tweaks,\`composer.keepQuestionsOpen\`:n?.value!==!1}),d(i.status),r(!1))}).catch(t=>{e&&(a(t instanceof Error?t.message:String(t)),r(!1))}),()=>{e=!1}},[]);` +
    `let l=(n,r)=>t(e=>({...e,[n]:r})),u=()=>{let n=window.electronBridge?.linuxRevisions?.request;if(typeof n!==\`function\`)return void a(\`Linux revisions bridge is unavailable.\`);s(!0),a(null),Promise.all([${request}(\`set-global-state\`,{params:{key:\`${SETTING_KEY}\`,value:e[\`composer.keepQuestionsOpen\`]}})),n({operation:\`apply\`,tweaks:e})]).then(()=>d(\`queued\`)).catch(e=>a(e instanceof Error?e.message:String(e))).finally(()=>s(!1))};` +
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
  const appMatches = names.filter((name) => /^app-initial-.*\.js$/.test(name) && fs.readFileSync(path.join(assetsDir, name), "utf8").includes("requestUserInputAutoResolution.snooze"));
  const settingsMatches = names.filter((name) => /^general-settings-.*\.js$/.test(name) && fs.readFileSync(path.join(assetsDir, name), "utf8").includes("slug:`general-settings`"));
  if ((enabled(context) && appMatches.length !== 1) || settingsMatches.length !== 1) {
    return { matched: 0, changed: 0, reason: `found ${appMatches.length} request and ${settingsMatches.length} settings assets`, targets: [] };
  }
  let requestAsset;
  try {
    requestAsset = findCodexRequestWebviewAsset(assetsDir);
  } catch (error) {
    return { matched: 0, changed: 0, reason: error.message, targets: [] };
  }
  const targets = [...(enabled(context) ? [appMatches[0]] : []), settingsMatches[0]];
  const originals = targets.map((name) => fs.readFileSync(path.join(assetsDir, name), "utf8"));
  const patched = targets.map((name, index) => name === settingsMatches[0]
    ? applyKeepQuestionsOpenSettingsPatch(originals[index], requestAsset, context)
    : applyKeepQuestionsOpenPatch(originals[index], context));
  if ((enabled(context) && !patched[0].includes(RUNTIME_MARKER)) || !patched.at(-1).includes(SETTINGS_MARKER)) {
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

const descriptors = [{
  id: "keep-questions-open",
  phase: "extracted-app:post-webview",
  order: 20_794,
  ciPolicy: "optional",
  apply: applyKeepQuestionsOpenAppPatch,
  status: (result) => result?.matched >= 1
    ? (result.changed > 0 ? "applied" : "already-applied")
    : { status: "skipped-optional", reason: result?.reason ?? null },
}];

module.exports = {
  RUNTIME_MARKER,
  SETTING_KEY,
  SETTINGS_MARKER,
  applyKeepQuestionsOpenAppPatch,
  applyKeepQuestionsOpenPatch,
  applyKeepQuestionsOpenSettingsPatch,
  config,
  descriptors,
};
