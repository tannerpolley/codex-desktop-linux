"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHANNEL = "codex-linux:revisions";
const MAIN_MARKER = "codexLinuxRevisionsBridgeVersion";
const PRELOAD_MARKER = "linuxRevisions:{request:";

function objectEnd(source, start) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote != null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === "`" || character === "\"" || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function applyPreloadBridgePatch(source) {
  if (source.includes(PRELOAD_MARKER)) return source;
  const exposures = [...source.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.exposeInMainWorld\s*\(\s*([`"'])electronBridge\2\s*,\s*(\{|[A-Za-z_$][\w$]*)/gu)];
  const candidates = [];
  for (const match of exposures) {
    let start = match.index + match[0].length;
    if (match[3] !== "{") {
      const declarations = [...source.matchAll(new RegExp(`(?:\\b(?:const|let|var)\\s+|,)${match[3]}=\\{`, "gu"))];
      if (declarations.length !== 1) continue;
      start = declarations[0].index + declarations[0][0].length;
    }
    const end = objectEnd(source, start);
    if (end === -1) continue;
    const body = source.slice(start, end);
    const ipc = body.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.invoke\s*\(/u)?.[1];
    if (ipc != null && /(?:^|,)\s*getSentryInitOptions\s*(?::|\()/u.test(body)) candidates.push({ body, end, ipc });
  }
  if (candidates.length !== 1) return source;
  const candidate = candidates[0];
  const separator = candidate.body.trimEnd().endsWith(",") ? "" : ",";
  return `${source.slice(0, candidate.end)}${separator}linuxRevisions:{request:request=>${candidate.ipc}.invoke(\`${CHANNEL}\`,request)}${source.slice(candidate.end)}`;
}

function mainBridgeSource(ipcMain, trusted) {
  return `(function(){
const ${MAIN_MARKER}=1;if(globalThis.${MAIN_MARKER}===1)return;globalThis.${MAIN_MARKER}=1;
const codexLinuxRevisionsFs=require(\`node:fs\`),codexLinuxRevisionsPath=require(\`node:path\`),codexLinuxRevisionsOs=require(\`node:os\`),codexLinuxRevisionsSpawn=require(\`node:child_process\`).spawn;
const codexLinuxRevisionsKeys=[[\`composer\`,\`keepQuestionsOpen\`],[\`composer\`,\`skillMentionOrdering\`],[\`appearance\`,\`dockIcon\`],[\`appearance\`,\`uiFontSize\`],[\`home\`,\`suggestedPrompts\`],[\`modelPicker\`,\`showModelsByDefault\`],[\`reasoning\`,\`keepEffortLabelsEnglish\`],[\`sidebar\`,\`projectName\`]];
const codexLinuxRevisionsConfigDir=codexLinuxRevisionsPath.join(process.env.XDG_CONFIG_HOME||codexLinuxRevisionsPath.join(codexLinuxRevisionsOs.homedir(),\`.config\`),\`codex-update-manager\`),codexLinuxRevisionsConfigPath=codexLinuxRevisionsPath.join(codexLinuxRevisionsConfigDir,\`features.json\`),codexLinuxRevisionsTemplatePath=codexLinuxRevisionsPath.join(process.resourcesPath,\`..\`,\`update-builder\`,\`linux-features\`,\`features.json\`),codexLinuxRevisionsStatePath=codexLinuxRevisionsPath.join(process.env.XDG_STATE_HOME||codexLinuxRevisionsPath.join(codexLinuxRevisionsOs.homedir(),\`.local\`,\`state\`),\`codex-update-manager\`,\`state.json\`);
function codexLinuxRevisionsReadJson(file){return JSON.parse(codexLinuxRevisionsFs.readFileSync(file,\`utf8\`))}
function codexLinuxRevisionsConfig(){const file=codexLinuxRevisionsFs.existsSync(codexLinuxRevisionsConfigPath)?codexLinuxRevisionsConfigPath:codexLinuxRevisionsTemplatePath;return codexLinuxRevisionsReadJson(file)}
function codexLinuxRevisionsValues(config){const tweaks=config?.settings?.[\`ui-tweaks\`]?.tweaks||{};return Object.fromEntries(codexLinuxRevisionsKeys.map(([group,key])=>[group+\`.\`+key,tweaks?.[group]?.[key]?.enabled===true]))}
function codexLinuxRevisionsStatus(){try{return codexLinuxRevisionsReadJson(codexLinuxRevisionsStatePath).status||\`unknown\`}catch{return\`unavailable\`}}
function codexLinuxRevisionsValidate(value){if(value===null||typeof value!==\`object\`||Array.isArray(value))throw Error(\`invalid revisions\`);const allowed=new Set(codexLinuxRevisionsKeys.map(([group,key])=>group+\`.\`+key));for(const key of Object.keys(value))if(!allowed.has(key)||typeof value[key]!==\`boolean\`)throw Error(\`invalid revision setting\`);if(Object.keys(value).length!==allowed.size)throw Error(\`incomplete revision settings\`)}
function codexLinuxRevisionsSave(value){codexLinuxRevisionsValidate(value);const config=codexLinuxRevisionsConfig();config.enabled=Array.from(new Set([...(Array.isArray(config.enabled)?config.enabled:[]),\`ui-tweaks\`]));config.settings??={};config.settings[\`ui-tweaks\`]??={};config.settings[\`ui-tweaks\`].tweaks??={};for(const[group,key]of codexLinuxRevisionsKeys){config.settings[\`ui-tweaks\`].tweaks[group]??={};const current=config.settings[\`ui-tweaks\`].tweaks[group][key];config.settings[\`ui-tweaks\`].tweaks[group][key]={...(current&&typeof current===\`object\`?current:{}),enabled:value[group+\`.\`+key]}}codexLinuxRevisionsFs.mkdirSync(codexLinuxRevisionsConfigDir,{recursive:true,mode:448});const temporary=codexLinuxRevisionsConfigPath+\`.\`+process.pid+\`.tmp\`;codexLinuxRevisionsFs.writeFileSync(temporary,JSON.stringify(config,null,2)+\`\\n\`,{mode:384});codexLinuxRevisionsFs.renameSync(temporary,codexLinuxRevisionsConfigPath)}
function codexLinuxRevisionsRebuild(){const executable=\`/usr/bin/codex-update-manager\`;if(!codexLinuxRevisionsFs.existsSync(executable))throw Error(\`codex-update-manager is not installed\`);const child=codexLinuxRevisionsSpawn(executable,[\`rebuild-current\`],{detached:true,stdio:\`ignore\`});child.on(\`error\`,()=>{});child.unref()}
${ipcMain}.handle(\`${CHANNEL}\`,async(event,request)=>{if(!${trusted}(event))return;if(request?.operation===\`get\`)return{tweaks:codexLinuxRevisionsValues(codexLinuxRevisionsConfig()),status:codexLinuxRevisionsStatus()};if(request?.operation===\`apply\`){codexLinuxRevisionsSave(request.tweaks);codexLinuxRevisionsRebuild();return{tweaks:request.tweaks,status:\`queued\`}}throw Error(\`invalid Linux revisions request\`)});
})();`;
}

function applyMainBridgePatch(source) {
  if (source.includes(`${MAIN_MARKER}=`)) return source;
  const issuesHandler = source.match(/((?:[A-Za-z_$][\w$]*\.)*ipcMain)\.handle\(codexLinuxGithubIssuesChannel,async\(event,request\)=>\{if\(!([A-Za-z_$][\w$]*)\(event\)\)return;/u);
  if (issuesHandler != null) {
    return `${source.slice(0, issuesHandler.index)}${mainBridgeSource(issuesHandler[1], issuesHandler[2])}${source.slice(issuesHandler.index)}`;
  }
  const modern = source.match(/(function\s+[A-Za-z_$][\w$]*\((?:[A-Za-z_$][\w$]*,)*([A-Za-z_$][\w$]*)\)\{return\s+([A-Za-z_$][\w$]*)\.ipcMain\.handle\([^,]+,async\([^,]+,[^)]*\)=>\{if\(!\2\([^)]*\)\)return(?:;|\{))/u);
  if (modern == null) return source;
  const body = source.indexOf("{", modern.index);
  return body === -1 ? source : `${source.slice(0, body + 1)}${mainBridgeSource(`${modern[3]}.ipcMain`, modern[2])}${source.slice(body + 1)}`;
}

function patchPreload(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) return { matched: false, changed: 0, reason: "preload build directory is missing" };
  const files = fs.readdirSync(buildDir).filter((name) => {
    if (!name.endsWith(".js")) return false;
    const source = fs.readFileSync(path.join(buildDir, name), "utf8");
    return source.includes("exposeInMainWorld") && source.includes("electronBridge");
  });
  if (files.length !== 1) return { matched: false, changed: 0, reason: `found ${files.length} preload bundles` };
  const file = path.join(buildDir, files[0]);
  const source = fs.readFileSync(file, "utf8");
  const patched = applyPreloadBridgePatch(source);
  if (!patched.includes(PRELOAD_MARKER)) return { matched: false, changed: 0, reason: "preload bridge anchor did not match" };
  if (patched !== source) fs.writeFileSync(file, patched);
  return { matched: true, changed: patched === source ? 0 : 1 };
}

const descriptors = [
  { id: "linux-revisions-main-bridge", phase: "main-bundle", order: 20_931, ciPolicy: "optional", apply: applyMainBridgePatch },
  { id: "linux-revisions-preload-bridge", phase: "extracted-app:post-webview", order: 20_932, ciPolicy: "optional", apply: patchPreload, status: (result) => result?.matched ? (result.changed ? "applied" : "already-applied") : { status: "skipped-optional", reason: result?.reason } },
];

module.exports = { CHANNEL, MAIN_MARKER, PRELOAD_MARKER, applyMainBridgePatch, applyPreloadBridgePatch, descriptors, mainBridgeSource };
