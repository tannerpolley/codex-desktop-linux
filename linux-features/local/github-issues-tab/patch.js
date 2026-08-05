"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  applyMainBridgePatch,
  applyPreloadBridgePatch,
} = require("./bridge-source.js");
const { findCodexRequestWebviewAsset } = require("../../../scripts/patches/lib/assets.js");
const { linuxSettingsKeys } = require("../../../scripts/patches/lib/settings-keys.js");

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
      if (!source.includes("githubIssues:{request:")) {
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

const ISSUES_ROUTE_MARKER = "codexLinuxGithubIssuesRouteMarker";
const ISSUES_ENVIRONMENT_MARKER = "codexLinuxGithubIssuesEnvironmentAction";
const ISSUES_SIDE_PANEL_MARKER = "codexLinuxGithubOpenIssuesSidePanel";
const ISSUES_SIDE_PANEL_COMPONENT_MARKER = "codexLinuxGithubIssuesPanelComponent";

function readWebviewAssets(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) return { assetsDir, entries: [] };
  const entries = fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const filePath = path.join(assetsDir, entry.name);
      return { name: entry.name, filePath, source: fs.readFileSync(filePath, "utf8") };
    });
  return { assetsDir, entries };
}

function driftResult(reason) {
  console.warn(`WARN: ${reason} - skipping GitHub Issues route patch`);
  return { matched: false, changed: 0, reason };
}

function findOne(entries, predicate, description) {
  const matches = entries.filter(predicate);
  if (matches.length !== 1) {
    return {
      error: matches.length === 0
        ? `no ${description} found`
        : `found ${matches.length} ${description}`,
    };
  }
  return { entry: matches[0] };
}

function captureCurrentMarkdownRenderer(entries) {
  const candidates = [];
  for (const entry of entries) {
    const descriptionIndex = entry.source.indexOf("pullRequestDetail.description.title");
    if (descriptionIndex === -1) continue;
    const renderMatch = entry.source.slice(descriptionIndex).match(/\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{account:[\s\S]*?allowBasicHtml:!0[\s\S]*?children:i\}\)/u);
    if (renderMatch == null) continue;
    const localName = renderMatch[2];
    const localPattern = new RegExp(`(?:^|,)\\s*([A-Za-z_$][\\w$]*)\\s+as\\s+${localName}(?=,|$)`, "u");
    for (const importMatch of entry.source.matchAll(/import\{([^}]*)\}from"\.\/([^"']+\.js)"/gu)) {
      if (!importMatch[2].startsWith("pull-request-code-review-state-")) continue;
      const imported = importMatch[1].match(localPattern);
      if (imported != null) candidates.push({ assetName: importMatch[2], exportedName: imported[1] });
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [`${candidate.assetName}:${candidate.exportedName}`, candidate])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function markdownRendererExpression(entries) {
  const renderer = captureCurrentMarkdownRenderer(entries);
  return renderer == null ? "null" : `(await import(${JSON.stringify(`/assets/${renderer.assetName}`)})).${renderer.exportedName}`;
}

function githubIssuesSettingProp(extractedDir) {
  try {
    const { assetName, exportName } = findCodexRequestWebviewAsset(
      path.join(extractedDir, "webview", "assets"),
    );
    const request = `(await import(${JSON.stringify(`/assets/${assetName}`)})).${exportName}`;
    return `,getSetting:key=>${request}("get-global-state",{params:{key:${JSON.stringify(linuxSettingsKeys.githubIssues)}}})`;
  } catch {
    // The Issues feature is optional. If an upstream request asset is not
    // discoverable, keep the existing feature usable and let the renderer's
    // default-on behavior preserve compatibility with that build.
    return "";
  }
}

function captureRouteShape(source) {
  const lazyPattern = /(?:\b(?:const|let|var)\s+|[,;])([A-Za-z_$][\w$]*)\s*=\s*(?:(?:[A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\(/g;
  const routeEntry = source.match(/(\(0,([A-Za-z_$][\w$]*)\.jsx\)\([A-Za-z_$][\w$]*,\{)path:`\/pull-requests`/);
  if (routeEntry == null) return null;
  const routeTableIndex = routeEntry.index;
  let lazyMatch = null;
  for (const candidate of source.matchAll(lazyPattern)) {
    if (candidate.index >= routeTableIndex) break;
    const candidateOpen = candidate.index + candidate[0].lastIndexOf("(");
    let depth = 0;
    let candidateClose = -1;
    for (let index = candidateOpen; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          candidateClose = index;
          break;
        }
      }
    }
    if (candidateClose !== -1 && (candidate[1] === "PullRequestsRoute" || source.slice(candidateOpen, candidateClose + 1).includes("PullRequestsRoute"))) {
      lazyMatch = candidate;
    }
  }
  if (lazyMatch == null) return null;
  const reactCandidates = [...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\(\),1\)/g)]
    .filter((match) => match.index < routeTableIndex && source.includes(`${match[1]}.Suspense`));
  const react = reactCandidates.at(-1)?.[1]
    ?? source.match(/\b(?:const|let|var)\s+(React)\s*=/)?.[1]
    ?? routeEntry[2]
    ?? null;
  if (react == null) return null;
  const declarationKeyword = lazyMatch[0].match(/^(?:const|let|var)\b/)?.[0] ?? null;
  let variableInsertAt = null;
  let expressionDelimiter = null;
  if (declarationKeyword == null) {
    expressionDelimiter = lazyMatch[0][0];
    if (expressionDelimiter !== "," && expressionDelimiter !== ";") return null;
    const declarationStart = source.lastIndexOf("var ", lazyMatch.index);
    const declarationEnd = declarationStart === -1 ? -1 : source.indexOf("=", declarationStart);
    if (declarationEnd !== -1 && declarationEnd < lazyMatch.index) {
      const declaredNames = source.slice(declarationStart + 4, declarationEnd).split(",").map((name) => name.trim());
      if (declaredNames.includes(react) && declaredNames.includes(lazyMatch[1])) {
        variableInsertAt = declarationStart + 4;
      }
    }
  }
  return {
    entryPrefix: routeEntry[1],
    jsxAlias: routeEntry[2],
    lazyWrapper: lazyMatch[2],
    lazyInsertAt: lazyMatch.index,
    variableInsertAt,
    expressionDelimiter,
    react,
  };
}

function findCircleDotImport(entries) {
  const matches = entries.filter(({ name, source }) =>
    /^circle-dot-(?!dashed-).*\.js$/.test(name) && /export\{[^}]+ as default\}/.test(source),
  );
  if (matches.length === 1) return matches[0];
  // Rolldown may emit both a thin re-export and its implementation. Prefer
  // the implementation so the injected import has a stable concrete module.
  const implementations = matches.filter(({ source }) => source.includes("createLucideIcon"));
  return implementations.length === 1 ? implementations[0] : null;
}

function patchIssuesRouteAssets(extractedDir) {
  const { entries } = readWebviewAssets(extractedDir);
  const routeResult = findOne(
    entries,
    ({ source }) => source.includes("path:`/pull-requests`") && source.includes("PullRequestsRoute"),
    "Pull Requests route assets",
  );
  if (routeResult.error) return driftResult(routeResult.error);
  const routeEntry = routeResult.entry;
  const routeShape = captureRouteShape(routeEntry.source);
  if (routeShape == null) return driftResult("Pull Requests lazy route or route-table anchor did not match");

  const routeAlreadyApplied = routeEntry.source.includes(ISSUES_ROUTE_MARKER);
  if (routeAlreadyApplied) return { matched: true, changed: 0 };

  const markerExpression = `const ${ISSUES_ROUTE_MARKER}=true;`;
  const routeVariable = "codexLinuxGithubIssuesRoute";
  const markdown = markdownRendererExpression(entries);
  const settingsProp = githubIssuesSettingProp(extractedDir);
  const routeAssignment = `${routeVariable}=${routeShape.lazyWrapper}(async()=>{const issuesModule=await import(\`/github-issues-tab.mjs\`);const openExternal=url=>{try{void Promise.resolve(window.electronBridge?.openExternal?.(url)).catch(()=>{})}catch{}};return issuesModule.createIssuesRoute({React:${routeShape.react},components:{},Markdown:${markdown},openExternal${settingsProp}})})`;
  let routeBody = routeEntry.source;
  if (routeShape.variableInsertAt == null) {
    const independentInsertAt = routeShape.lazyInsertAt + (routeShape.expressionDelimiter === "," ? 1 : 0);
    const independentAssignment = routeShape.expressionDelimiter === ","
      ? `${routeAssignment},`
      : `const ${routeAssignment};`;
    routeBody = `${routeBody.slice(0, independentInsertAt)}${independentAssignment}${routeBody.slice(independentInsertAt)}`;
  } else {
    routeBody = `${routeBody.slice(0, routeShape.variableInsertAt)}${routeVariable},${routeBody.slice(routeShape.variableInsertAt)}`;
    const adjustedLazyInsertAt = routeShape.lazyInsertAt + routeVariable.length + 1;
    routeBody = `${routeBody.slice(0, adjustedLazyInsertAt)}${routeShape.expressionDelimiter}${routeAssignment}${routeBody.slice(adjustedLazyInsertAt)}`;
  }
  const routeDeclaration = routeShape.variableInsertAt == null && routeShape.expressionDelimiter === ","
    ? `let ${routeVariable};`
    : "";
  let routeSource = markerExpression + routeDeclaration + routeBody;
  const patchedRouteMarkerIndex = routeSource.indexOf("path:`/pull-requests`", markerExpression.length);
  const patchedEntryStart = patchedRouteMarkerIndex - routeShape.entryPrefix.length;
  routeSource = routeSource.slice(0, patchedEntryStart) + `${routeShape.entryPrefix}path:\`/issues\`,element:(0,${routeShape.jsxAlias}.jsx)(codexLinuxGithubIssuesRoute,{})}),` + routeSource.slice(patchedEntryStart);
  if (routeSource !== routeEntry.source) fs.writeFileSync(routeEntry.filePath, routeSource, "utf8");
  return { matched: true, changed: 1 };
}

function findFunctionRange(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const parameterOpen = source.indexOf("(", start);
  if (parameterOpen === -1) return null;
  let parameterDepth = 0;
  let quote = null;
  let escaped = false;
  let parameterClose = -1;
  for (let index = parameterOpen; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "`" || character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") parameterDepth += 1;
    else if (character === ")" && --parameterDepth === 0) {
      parameterClose = index;
      break;
    }
  }
  if (parameterClose === -1) return null;
  const open = source.indexOf("{", parameterClose);
  if (open === -1) return null;
  let depth = 0;
  quote = null;
  escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
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
    else if (character === "}" && --depth === 0) return { start, open, end: index + 1 };
  }
  return null;
}

function patchFunctionBody(source, name, callback) {
  const range = findFunctionRange(source, name);
  if (range == null) return { source, matched: false };
  const body = source.slice(range.start, range.end);
  const patchedBody = callback(body);
  return { source: `${source.slice(0, range.start)}${patchedBody}${source.slice(range.end)}`, matched: true };
}

function addIssuesCallbackBinding(body) {
  const headerEnd = body.indexOf("}=e");
  if (headerEnd !== -1) {
    const header = body.slice(0, headerEnd);
    if (header.includes("onOpenIssuesSidePanel:codexLinuxIssuesOpen")) return body;
    return `${body.slice(0, headerEnd)},onOpenIssuesSidePanel:codexLinuxIssuesOpen${body.slice(headerEnd)}`;
  }
  const parameterMatch = body.match(/function [A-Za-z_$][\w$]*\(\{[^{}]*\}\)/u);
  if (parameterMatch == null) return null;
  if (parameterMatch[0].includes("onOpenIssuesSidePanel:codexLinuxIssuesOpen")) return body;
  const parameterClose = parameterMatch.index + parameterMatch[0].lastIndexOf("}");
  return `${body.slice(0, parameterClose)},onOpenIssuesSidePanel:codexLinuxIssuesOpen${body.slice(parameterClose)}`;
}

function addIssuesCallbackToCall(body, componentName) {
  const pattern = new RegExp(`(\\.jsx\\)\\(${componentName},\\{)(?!onOpenIssuesSidePanel:codexLinuxIssuesOpen,)`);
  return body.replace(pattern, "$1onOpenIssuesSidePanel:codexLinuxIssuesOpen,");
}

function patchIssuesSummaryAsset(source) {
  if (source.includes(ISSUES_ENVIRONMENT_MARKER)) return source;
  if (!source.includes("sectionKey:`environment`") || !source.includes("onOpenPullRequestSidePanel")) return null;

  let patched = source;
  for (const [name, child] of [["jC", "TC"], ["MC", "TC"]]) {
    const result = patchFunctionBody(patched, name, (body) => {
      const withBinding = addIssuesCallbackBinding(body);
      if (withBinding == null) return body;
      return addIssuesCallbackToCall(withBinding, child);
    });
    if (!result.matched || result.source === patched) return null;
    patched = result.source;
  }

  const tcResult = patchFunctionBody(patched, "TC", (body) => {
    const withBinding = addIssuesCallbackBinding(body);
    if (withBinding == null) return body;
    const jsxMatch = withBinding.match(/\(0,([A-Za-z_$][\w$]*)\.(?:jsx|jsxs)\)\(([A-Za-z_$][\w$]*)\.Section,\{sectionKey:`environment`/u);
    if (jsxMatch == null) return body;
    const [, jsxAlias, componentAlias] = jsxMatch;
    const action = `const ${ISSUES_ENVIRONMENT_MARKER}=(0,${jsxAlias}.jsx)(${componentAlias}.ItemButton,{onClick:()=>{codexLinuxIssuesOpen?.()},children:(0,${jsxAlias}.jsx)(${componentAlias}.ItemLabel,{children:\`Issues\`})});`;
    const functionBodyStart = withBinding.indexOf("{") + 1;
    let next = `${withBinding.slice(0, functionBodyStart)}${action}${withBinding.slice(functionBodyStart)}`;
    const environmentIndex = next.indexOf("sectionKey:`environment`");
    const childrenStart = next.indexOf("children:[", environmentIndex);
    const childrenEnd = childrenStart === -1 ? -1 : next.indexOf("]", childrenStart);
    if (childrenStart === -1 || childrenEnd === -1) return body;
    return `${next.slice(0, childrenEnd)},${ISSUES_ENVIRONMENT_MARKER}${next.slice(childrenEnd)}`;
  });
  if (!tcResult.matched || tcResult.source === patched) return null;
  return tcResult.source;
}

function patchCurrentIssuesSummaryAsset(source) {
  if (source.includes(ISSUES_ENVIRONMENT_MARKER)) return source;
  if (!source.includes("function JC(")
    || !source.includes("environmentSummary.title")
    || !source.includes("sectionKey:F")
    || !source.includes("children:[R,z,P,H,ee]")) return null;

  const range = findFunctionRange(source, "JC");
  if (range == null) return null;
  const body = source.slice(range.start, range.end);
  if (!body.includes("_=bt(pu),")) return null;

  const icon = captureCurrentPullRequestIcon(source);
  if (icon == null) return null;
  const action = `${ISSUES_ENVIRONMENT_MARKER}=(0,ZC.jsx)(X.ItemButton,{onClick:()=>{${ISSUES_SIDE_PANEL_MARKER}(_,{root:a})},children:[(0,ZC.jsx)(X.ItemLeading,{children:(0,${icon.jsxAlias}.jsx)(${icon.componentAlias},{})}),(0,ZC.jsx)(X.ItemLabel,{children:\`Issues\`})]}),`;
  const withAction = body.replace("_=bt(pu),", `_=bt(pu),${action}`);
  if (withAction === body) return null;
  const withIssueRow = withAction.replace("children:[R,z,P,H,ee]", `children:[R,z,P,H,ee,${ISSUES_ENVIRONMENT_MARKER}]`);
  if (withIssueRow === withAction) return null;
  return `${source.slice(0, range.start)}${withIssueRow}${source.slice(range.end)}`;
}

function captureCurrentPullRequestIcon(source) {
  const match = source.match(/function FC\([\s\S]*?\(0,([A-Za-z_$][\w$]*)\.jsx\)\(X\.ItemLeading,\{children:\(0,\1\.jsx\)\(([A-Za-z_$][\w$]*),\{\}\)\}\)/u);
  return match == null ? null : { jsxAlias: match[1], componentAlias: match[2] };
}

function patchIssuesSummaryAssets(extractedDir) {
  const { entries } = readWebviewAssets(extractedDir);
  const currentResult = findOne(
    entries,
    ({ source }) => source.includes("function JC(")
      && source.includes("environmentSummary.title")
      && source.includes("sectionKey:F")
      && (source.includes("children:[R,z,P,H,ee]")
        || source.includes(ISSUES_ENVIRONMENT_MARKER)),
    "current Environment summary assets",
  );
  if (!currentResult.error) {
    const entry = currentResult.entry;
    const patched = patchCurrentIssuesSummaryAsset(entry.source);
    if (patched == null) return driftResult("current Environment summary callback anchors did not match");
    if (patched === entry.source) return { matched: true, changed: 0 };
    fs.writeFileSync(entry.filePath, patched, "utf8");
    return { matched: true, changed: 1 };
  }

  const result = findOne(
    entries,
    ({ source }) => source.includes("function TC(") && source.includes("function jC(") && source.includes("function MC(") && source.includes("sectionKey:`environment`"),
    "current Environment summary assets",
  );
  if (result.error) return driftResult(result.error);
  const entry = result.entry;
  const patched = patchIssuesSummaryAsset(entry.source);
  if (patched == null) return driftResult("Environment summary callback anchors did not match");
  if (patched === entry.source) return { matched: true, changed: 0 };
  fs.writeFileSync(entry.filePath, patched, "utf8");
  return { matched: true, changed: 1 };
}

function patchCurrentIssuesCallbackChain(source) {
  let patched = source;
  const steps = [
    ["_O", "SO"],
    ["SO", "kT"],
    ["kT", "PT"],
    ["jT", "PT"],
    ["PT", "IT"],
    ["IT", "AC"],
  ];
  for (const [name, child] of steps) {
    const result = patchFunctionBody(patched, name, (body) => {
      const withBinding = addIssuesCallbackBinding(body);
      if (withBinding == null) return body;
      return addIssuesCallbackToCall(withBinding, child);
    });
    if (!result.matched || result.source === patched) return null;
    patched = result.source;
  }
  return patched;
}

function patchIssuesSidePanelAssets(extractedDir) {
  const { entries } = readWebviewAssets(extractedDir);

  const currentResult = findOne(
    entries,
    ({ source }) => source.includes("function JC(")
      && source.includes("function PT(")
      && source.includes("dm.openTab("),
    "current local conversation side-panel asset",
  );
  if (!currentResult.error) {
    const current = currentResult.entry;
    if (current.source.includes(ISSUES_SIDE_PANEL_COMPONENT_MARKER)) return { matched: true, changed: 0 };
    const icon = captureCurrentPullRequestIcon(current.source);
    if (icon == null) return driftResult("current Pull Request icon anchor did not match");
    const markdown = markdownRendererExpression(entries);
    const settingsProp = githubIssuesSettingProp(extractedDir);
    const opener = `const ${ISSUES_SIDE_PANEL_COMPONENT_MARKER}=t(Sl(),1).lazy(()=>import(\`/github-issues-tab.mjs\`).then(async issuesModule=>({default:issuesModule.createIssuesSidePanel({React:t(Sl(),1),components:{},Markdown:${markdown},openExternal:url=>{try{void Promise.resolve(window.electronBridge?.openExternal?.(url)).catch(()=>{})}catch{}}${settingsProp}})})));function ${ISSUES_SIDE_PANEL_MARKER}(scope,options={}){dm.openTab(scope,${ISSUES_SIDE_PANEL_COMPONENT_MARKER},{icon:(0,${icon.jsxAlias}.jsx)(${icon.componentAlias},{}),activate:!0,id:\`issues\`,props:options,title:\`Issues\`});return!0}`;
    const anchor = "function JC(";
    const anchorIndex = current.source.indexOf(anchor);
    if (anchorIndex === -1) return driftResult("current local conversation side-panel registration anchor did not match");
    const patched = `${current.source.slice(0, anchorIndex)}${opener}${current.source.slice(anchorIndex)}`;
    fs.writeFileSync(current.filePath, patched, "utf8");
    return { matched: true, changed: 1 };
  }

  const result = findOne(
    entries,
    ({ source }) => source.includes("function Xl(e,{hostId:") && source.includes("pull-request:") && source.includes("openTab"),
    "current local conversation side-panel asset",
  );
  if (result.error) return driftResult(result.error);
  const current = result.entry;
  if (current.source.includes(ISSUES_SIDE_PANEL_MARKER)) return { matched: true, changed: 0 };

  const icon = findCircleDotImport(entries);
  const xlRange = findFunctionRange(current.source, "Xl");
  if (icon == null || xlRange == null) {
    return driftResult(icon == null
      ? "no unique circle-dot icon asset found for Issues side panel"
      : "Pull Request side-panel opener anchor did not match");
  }
  const xlBody = current.source.slice(xlRange.start, xlRange.end);
  const reactAlias = xlBody.match(/\(0,([A-Za-z_$][\w$]*)\.createElement\)/)?.[1];
  const locationAlias = xlBody.match(/\b([A-Za-z_$][\w$]*)\(e,s\)\?\?o/)?.[1];
  const openTabsAlias = xlBody.match(/\b([A-Za-z_$][\w$]*)\(c\)\.openTab\(e,/)?.[1];
  const activateAlias = xlBody.match(/\b([A-Za-z_$][\w$]*)\(e,c\)/)?.[1];
  if (reactAlias == null || locationAlias == null || openTabsAlias == null || activateAlias == null) {
    return driftResult("Pull Request side-panel aliases did not match");
  }

  let patched = `import codexLinuxGithubIssuesIcon from \"./${icon.name}\";${current.source}`;
  const markdown = markdownRendererExpression(entries);
  const settingsProp = githubIssuesSettingProp(extractedDir);
  const opener = `const codexLinuxGithubIssuesPanel=${reactAlias}.lazy(()=>import(\`/github-issues-tab.mjs\`).then(async issuesModule=>({default:issuesModule.createIssuesSidePanel({React:${reactAlias},components:{},Markdown:${markdown},openExternal:url=>{try{void Promise.resolve(window.electronBridge?.openExternal?.(url)).catch(()=>{})}catch{}}${settingsProp}})})));function ${ISSUES_SIDE_PANEL_MARKER}(scope,options={}){const side=${locationAlias}(scope,\`issues\`)??\`right\`;${openTabsAlias}(side).openTab(scope,codexLinuxGithubIssuesPanel,{activate:!0,defaultState:()=>({}),icon:${reactAlias}.createElement(codexLinuxGithubIssuesIcon,{className:\`icon-xs shrink-0\`}),id:\`issues\`,props:options,title:\`Issues\`,tooltip:\`Issues\`});${activateAlias}(scope,side);return!0}`;
  const xlIndex = patched.indexOf("function Xl(");
  patched = `${patched.slice(0, xlIndex)}${opener}${patched.slice(xlIndex)}`;
  const rootResult = patchFunctionBody(patched, "$u", (body) => {
    const injectAnchor = "let k=un(O),";
    if (!body.includes(injectAnchor)) return body;
    let next = body.replace(
      injectAnchor,
      `let codexLinuxIssuesOpen=un(()=>{${ISSUES_SIDE_PANEL_MARKER}(i,{hostId:l})}),${injectAnchor.slice(4)}`,
    );
    return next.replace(
      "onOpenPullRequestSidePanel:k,onOpenSubagentsPanel:D",
      "onOpenPullRequestSidePanel:k,onOpenIssuesSidePanel:codexLinuxIssuesOpen,onOpenSubagentsPanel:D",
    );
  });
  if (!rootResult.matched || rootResult.source === patched) {
    return driftResult("local conversation root callback anchor did not match");
  }
  patched = rootResult.source;

  const threadResult = findOne(
    entries,
    ({ source }) => source.includes("function _O(") && source.includes("function SO(") && source.includes("onOpenPullRequestSidePanel"),
    "current local conversation callback chain asset",
  );
  if (threadResult.error) return driftResult(threadResult.error);
  const threadPatched = patchCurrentIssuesCallbackChain(threadResult.entry.source);
  if (threadPatched == null) return driftResult("current local conversation callback chain anchors did not match");

  fs.writeFileSync(current.filePath, patched, "utf8");
  fs.writeFileSync(threadResult.entry.filePath, threadPatched, "utf8");
  return { matched: true, changed: 2 };
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
  {
    id: "github-issues-renderer-route",
    phase: "extracted-app:post-webview",
    order: 20_932,
    ciPolicy: "optional",
    apply: patchIssuesRouteAssets,
    status: optionalDriftStatus,
  },
  {
    id: "github-issues-summary",
    phase: "extracted-app:post-webview",
    order: 20_933,
    ciPolicy: "optional",
    apply: patchIssuesSummaryAssets,
    status: optionalDriftStatus,
  },
  {
    id: "github-issues-side-panel",
    phase: "extracted-app:post-webview",
    order: 20_934,
    ciPolicy: "optional",
    apply: patchIssuesSidePanelAssets,
    status: optionalDriftStatus,
  },
];

module.exports = {
  descriptors,
  applyMainBridgePatch,
  patchPreloadBridgeAssets,
  optionalDriftStatus,
  walkJavaScriptFiles,
  patchIssuesRouteAssets,
  patchIssuesSummaryAssets,
  patchIssuesSidePanelAssets,
  ISSUES_ROUTE_MARKER,
  ISSUES_ENVIRONMENT_MARKER,
  ISSUES_SIDE_PANEL_MARKER,
  ISSUES_SIDE_PANEL_COMPONENT_MARKER,
};
