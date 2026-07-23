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
const ISSUES_NAV_MARKER = "sidebarElectron.issuesRouteNavLink";
const ISSUES_ENVIRONMENT_MARKER = "codexLinuxGithubIssuesEnvironmentAction";
const ISSUES_SIDE_PANEL_MARKER = "codexLinuxGithubOpenIssuesSidePanel";

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
    if (declarationEnd === -1 || declarationEnd >= lazyMatch.index) return null;
    const declaredNames = source.slice(declarationStart + 4, declarationEnd).split(",").map((name) => name.trim());
    if (!declaredNames.includes(react) || !declaredNames.includes(lazyMatch[1])) return null;
    variableInsertAt = declarationStart + 4;
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

function findPullRequestMarkdownDependency(entries) {
  const candidates = [];
  for (const entry of entries) {
    if (!/^pull-request-route-.*\.js$/.test(entry.name)) continue;
    const markdownCall = entry.source.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{[^}]*allowBasicHtml:!0[^}]*children:e\}\)/);
    if (markdownCall == null) continue;
    const localMarkdown = markdownCall[1];
    const importPattern = /import\{([^}]+)\}from"\.\/(pull-request-actions-[^"]+\.js)"/g;
    for (const importMatch of entry.source.matchAll(importPattern)) {
      const specifier = importMatch[1].split(",").map((part) => part.trim());
      const imported = specifier.map((part) => {
        const alias = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (alias != null && alias[2] === localMarkdown) return alias[1];
        return part === localMarkdown ? part : null;
      }).find((value) => value != null);
      if (imported == null) continue;
      const actionEntry = entries.find(({ name }) => name === importMatch[2]);
      const exportBlock = actionEntry?.source.match(/export\{[^}]+\}/)?.[0] ?? "";
      const exported = exportBlock.match(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${imported}\\b`));
      const sourceSymbol = exported?.[1];
      const sourceStart = actionEntry == null || sourceSymbol == null
        ? -1
        : actionEntry.source.search(new RegExp(`(?:function|const|let|var)\\s+${sourceSymbol}\\b`));
      if (actionEntry == null || sourceStart === -1 || !actionEntry.source.slice(sourceStart, sourceStart + 2500).includes("children")) continue;
      candidates.push({ actionName: actionEntry.name, markdownExport: imported });
    }
  }
  if (candidates.length !== 1) {
    return {
      error: candidates.length === 0
        ? "no Pull Requests raw Markdown dependency asset found"
        : `found ${candidates.length} Pull Requests raw Markdown dependency assets`,
    };
  }
  return { dependency: candidates[0] };
}

function captureNavShape(source) {
  const navStart = source.indexOf("sidebarElectron.pullRequestsRouteNavLink");
  if (navStart === -1) return null;
  const iconStart = source.lastIndexOf("icon:", navStart);
  const start = iconStart === -1 ? -1 : source.lastIndexOf("(0,", iconStart);
  if (start === -1) return null;
  const factory = source.slice(start).match(/^\(0,[A-Za-z_$][\w$]*\.jsx\)/)?.[0];
  if (factory == null) return null;
  const callStart = start + factory.length;
  let depth = 0;
  let end = -1;
  for (let index = callStart; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  const block = source.slice(start, end);
  if (!block.includes("/pull-requests") || !block.includes("defaultMessage:`Pull requests`")) return null;
  const click = block.match(/onClick:\(\)=>\{[^{}]*\}/);
  if (click == null) return null;
  const navigateCall = click[0].match(/\b([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/);
  if (navigateCall == null) return null;
  const navigateAlias = navigateCall[3];
  const scopeStart = source.lastIndexOf("function ", navStart);
  const navigateScope = source.slice(scopeStart === -1 ? 0 : scopeStart, navStart);
  const navigateAssignments = [...navigateScope.matchAll(new RegExp(`(?:^|[,;])${navigateAlias}=ln\\(\\),`, "g"))];
  if (navigateAssignments.length !== 1) return null;
  return { start, end, block, navigateAlias };
}

function captureNavContainer(source, navShape) {
  const before = source.slice(0, navShape.start);
  const conditional = before.match(/([A-Za-z_$][\w$]*)\?\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{electron:!0,children:$/);
  if (conditional == null) return null;
  const callStart = before.lastIndexOf("(");
  let depth = 0;
  let callEnd = -1;
  for (let index = callStart; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        callEnd = index + 1;
        break;
      }
    }
  }
  if (callEnd === -1 || source.slice(callEnd, callEnd + 5) !== ":null") return null;
  return {
    end: callEnd + 5,
    condition: conditional[1],
    jsxAlias: conditional[2],
    component: conditional[3],
  };
}

function findCircleDotImport(entries) {
  const matches = entries.filter(({ name, source }) =>
    /^circle-dot-(?!dashed-).*\.js$/.test(name) && /export\{[^}]+ as default\}/.test(source),
  );
  if (matches.length !== 1) return null;
  return matches[0];
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
  const dependencyResult = findPullRequestMarkdownDependency(entries);
  const routeShape = captureRouteShape(routeEntry.source);
  if (dependencyResult.error) return driftResult(dependencyResult.error);
  if (routeShape == null) return driftResult("Pull Requests lazy route or route-table anchor did not match");

  const routeAlreadyApplied = routeEntry.source.includes(ISSUES_ROUTE_MARKER);
  if (routeAlreadyApplied) return { matched: true, changed: 0 };

  const markerExpression = `const ${ISSUES_ROUTE_MARKER}=true;`;
  const routeVariable = "codexLinuxGithubIssuesRoute";
  const routeAssignment = `${routeVariable}=${routeShape.lazyWrapper}(async()=>{const [issuesModule,markdownModule]=await Promise.all([import(\`/github-issues-tab.mjs\`),import(\`./${dependencyResult.dependency.actionName}\`)]);const openExternal=url=>{try{void Promise.resolve(window.electronBridge?.openExternal?.(url)).catch(()=>{})}catch{}};return issuesModule.createIssuesRoute({React:${routeShape.react},components:{},Markdown:markdownModule.${dependencyResult.dependency.markdownExport},openExternal})})`;
  let routeBody = routeEntry.source;
  if (routeShape.variableInsertAt == null) {
    routeBody = `${routeBody.slice(0, routeShape.lazyInsertAt)}const ${routeAssignment};${routeBody.slice(routeShape.lazyInsertAt)}`;
  } else {
    routeBody = `${routeBody.slice(0, routeShape.variableInsertAt)}${routeVariable},${routeBody.slice(routeShape.variableInsertAt)}`;
    const adjustedLazyInsertAt = routeShape.lazyInsertAt + routeVariable.length + 1;
    routeBody = `${routeBody.slice(0, adjustedLazyInsertAt)}${routeShape.expressionDelimiter}${routeAssignment}${routeBody.slice(adjustedLazyInsertAt)}`;
  }
  let routeSource = markerExpression + routeBody;
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
  if (body.includes("onOpenIssuesSidePanel:codexLinuxIssuesOpen")) return body;
  const headerEnd = body.indexOf("}=e");
  if (headerEnd === -1) return null;
  return `${body.slice(0, headerEnd)},onOpenIssuesSidePanel:codexLinuxIssuesOpen${body.slice(headerEnd)}`;
}

function addIssuesCallbackToCall(body, componentName) {
  const pattern = new RegExp(`(\\.jsx\\)\\(${componentName},\\{)`);
  return body.replace(pattern, "$1onOpenIssuesSidePanel:codexLinuxIssuesOpen,");
}

function patchIssuesSummaryAsset(source) {
  if (source.includes(ISSUES_ENVIRONMENT_MARKER)) return source;
  if (!source.includes("sectionKey:`environment`") || !source.includes("onOpenPullRequestSidePanel")) return null;

  // 26.715 consolidated the summary into Uy and threaded the PR opener
  // through Jx -> Qx -> $x -> Jy. Patch that stable callback chain directly.
  if (findFunctionRange(source, "Uy") != null && findFunctionRange(source, "Yy") != null) {
    let patched = source;
    const bind = (name, field) => {
      const result = patchFunctionBody(patched, name, (body) => {
        if (body.includes(`onOpenIssuesSidePanel:${field}`)) return body;
        const headerEnd = body.indexOf("}=e");
        return headerEnd === -1
          ? body
          : `${body.slice(0, headerEnd)},onOpenIssuesSidePanel:${field}${body.slice(headerEnd)}`;
      });
      if (!result.matched) return false;
      patched = result.source;
      return true;
    };
    // Use the local minified names in each function's destructuring list.
    if (!bind("Jx", "codexLinuxIssuesOpen") || !bind("Xx", "codexLinuxIssuesOpen") || !bind("Qx", "codexLinuxIssuesOpen") || !bind("$x", "codexLinuxIssuesOpen") || !bind("Yy", "codexLinuxIssuesOpen") || !bind("Xy", "codexLinuxIssuesOpen") || !bind("Uy", "codexLinuxIssuesOpen")) return null;
    const addProp = (name, child) => {
      const result = patchFunctionBody(patched, name, (body) => {
        const pattern = new RegExp(`(\\.jsx\\)\\(${child},\\{)`);
        return body.replace(pattern, "$1onOpenIssuesSidePanel:codexLinuxIssuesOpen,");
      });
      if (!result.matched) return false;
      patched = result.source;
      return true;
    };
    if (!addProp("Jx", "Qx") || !addProp("Xx", "Qx") || !addProp("Qx", "$x") || !addProp("$x", "Jy") || !addProp("Yy", "Uy") || !addProp("Xy", "Uy")) return null;

    const uyRange = findFunctionRange(patched, "Uy");
    if (uyRange == null) return null;
    let body = patched.slice(uyRange.start, uyRange.end);
    const jsxMatch = body.match(/\(0,([A-Za-z_$][\w$]*)\.(?:jsx|jsxs)\)\(([A-Za-z_$][\w$]*)\.Section,\{sectionKey:`environment`/u);
    if (jsxMatch == null) return null;
    const [, jsxAlias, componentAlias] = jsxMatch;
    const action = `const ${ISSUES_ENVIRONMENT_MARKER}=(0,${jsxAlias}.jsx)(${componentAlias}.ItemButton,{onClick:()=>{codexLinuxIssuesOpen?.()},children:(0,${jsxAlias}.jsx)(${componentAlias}.ItemLabel,{children:\`Issues\`})});`;
    body = `${body.slice(0, body.indexOf("{") + 1)}${action}${body.slice(body.indexOf("{") + 1)}`;
    const environmentIndex = body.indexOf("sectionKey:`environment`");
    const childrenStart = body.indexOf("children:[", environmentIndex);
    const childrenEnd = childrenStart === -1 ? -1 : body.indexOf("]", childrenStart);
    if (childrenStart === -1 || childrenEnd === -1) return null;
    body = `${body.slice(0, childrenEnd)},${ISSUES_ENVIRONMENT_MARKER}${body.slice(childrenEnd)}`;
    return `${patched.slice(0, uyRange.start)}${body}${patched.slice(uyRange.end)}`;
  }

  const required = ["Lv", "Uv", "Wv", "Hv", "Bb", "zb", "Lb", "Fb"];
  let patched = source;
  for (const name of required) {
    const result = patchFunctionBody(patched, name, (body) => {
      const withBinding = addIssuesCallbackBinding(body);
      return withBinding == null ? body : withBinding;
    });
    if (!result.matched || result.source === patched && !findFunctionRange(patched, name)) return null;
    patched = result.source;
  }
  for (const [name, child] of [["Lv", null], ["Uv", "Lv"], ["Wv", "Lv"], ["Hv", null], ["Bb", "Hv"], ["zb", "Bb"], ["Lb", "zb"], ["Fb", "zb"], ["ZS", "Fb"], ["KS", "ZS"]]) {
    if (child == null) continue;
    if (findFunctionRange(patched, name) == null) continue;
    const result = patchFunctionBody(patched, name, (body) => addIssuesCallbackToCall(body, child));
    if (!result.matched) return null;
    patched = result.source;
  }

  const range = findFunctionRange(patched, "Lv");
  if (range == null) return null;
  let body = patched.slice(range.start, range.end);
  const jsxAlias = body.match(/\(0,([A-Za-z_$][\w$]*)\.(?:jsx|jsxs)\)\([A-Za-z_$][\w$]*\.Section,\{sectionKey:`environment`/u)?.[1];
  const componentAlias = body.match(/\(0,[A-Za-z_$][\w$]*\.(?:jsx|jsxs)\)\(([A-Za-z_$][\w$]*)\.Section,\{sectionKey:`environment`/u)?.[1];
  if (jsxAlias == null || componentAlias == null) return null;
  const action = `const ${ISSUES_ENVIRONMENT_MARKER}=(0,${jsxAlias}.jsx)(${componentAlias}.ItemButton,{onClick:()=>{codexLinuxIssuesOpen?.()},children:(0,${jsxAlias}.jsx)(${componentAlias}.ItemLabel,{children:\`Issues\`})});`;
  body = `${body.slice(0, body.indexOf("{") + 1)}${action}${body.slice(body.indexOf("{") + 1)}`;
  const environmentIndex = body.indexOf("sectionKey:`environment`");
  const childrenStart = body.indexOf("children:[", environmentIndex);
  const childrenEnd = childrenStart === -1 ? -1 : body.indexOf("]", childrenStart);
  if (childrenStart === -1 || childrenEnd === -1) return null;
  body = `${body.slice(0, childrenEnd)},${ISSUES_ENVIRONMENT_MARKER}${body.slice(childrenEnd)}`;
  return `${patched.slice(0, range.start)}${body}${patched.slice(range.end)}`;
}

function patchIssuesSummaryAssets(extractedDir) {
  const { entries } = readWebviewAssets(extractedDir);
  const result = findOne(entries, ({ source }) => source.includes("sectionKey:`environment`") && source.includes("function Lv"), "Environment summary assets");
  if (result.error) return driftResult(result.error);
  const entry = result.entry;
  const patched = patchIssuesSummaryAsset(entry.source);
  if (patched == null) return driftResult("Environment summary callback anchors did not match");
  if (patched === entry.source) return { matched: true, changed: 0 };
  fs.writeFileSync(entry.filePath, patched, "utf8");
  return { matched: true, changed: 1 };
}

function patchIssuesSidePanelAssets(extractedDir) {
  const { entries } = readWebviewAssets(extractedDir);
  const modern = entries.find(({ source }) => source.includes("function Sl(") && source.includes("pull-request:") && source.includes("openTab"));
  if (modern != null && !modern.source.includes(ISSUES_SIDE_PANEL_MARKER)) {
    const icon = findCircleDotImport(entries);
    const slRange = findFunctionRange(modern.source, "Sl");
    if (icon == null || slRange == null) return driftResult(icon == null ? "no unique circle-dot icon asset found for Issues side panel" : "Pull Request side-panel opener anchor did not match");
    const slBody = modern.source.slice(slRange.start, slRange.end);
    const reactAlias = slBody.match(/\(0,([A-Za-z_$][\w$]*)\.createElement\)/)?.[1] ?? modern.source.match(/\bvar ([A-Za-z_$][\w$]*),/)?.[1];
    const locationAlias = slBody.match(/\b([A-Za-z_$][\w$]*)\(e,o\)\?\?a/)?.[1];
    const openTabsAlias = slBody.match(/\b([A-Za-z_$][\w$]*)\(s\)\.openTab\(/)?.[1];
    const activateAlias = slBody.match(/\b([A-Za-z_$][\w$]*)\(e,s\)/)?.[1];
    if (reactAlias == null || locationAlias == null || openTabsAlias == null || activateAlias == null) return driftResult("Pull Request side-panel aliases did not match");
    let patched = `import codexLinuxGithubIssuesIcon from \"./${icon.name}\";${modern.source}`;
    const opener = `const codexLinuxGithubIssuesPanel=${reactAlias}.lazy(()=>import(\`/github-issues-tab.mjs\`).then(issuesModule=>({default:issuesModule.createIssuesSidePanel({React:${reactAlias},components:{},openExternal:url=>{try{void Promise.resolve(window.electronBridge?.openExternal?.(url)).catch(()=>{})}catch{}}})})));function ${ISSUES_SIDE_PANEL_MARKER}(scope){const side=${locationAlias}(scope,\`issues\`)??\`right\`;${openTabsAlias}(side).openTab(scope,codexLinuxGithubIssuesPanel,{activate:!0,defaultState:()=>({}),icon:${reactAlias}.createElement(codexLinuxGithubIssuesIcon,{className:\`icon-xs shrink-0\`}),id:\`issues\`,props:{},title:\`Issues\`,tooltip:\`Issues\`});${activateAlias}(scope,side);return!0}`;
    const slIndex = patched.indexOf("function Sl(");
    patched = `${patched.slice(0, slIndex)}${opener}${patched.slice(slIndex)}`;
    const kuResult = patchFunctionBody(patched, "ku", (body) => {
      if (!body.includes("onOpenPullRequestSidePanel:N")) return body;
      const callback = `codexLinuxIssuesOpen=()=>{${ISSUES_SIDE_PANEL_MARKER}(s,{hostId:f})}`;
      const injectAt = body.indexOf("let N=De(M)");
      if (injectAt === -1) return body;
      let next = `${body.slice(0, injectAt)}let ${callback};${body.slice(injectAt)}`;
      next = next.replace("onOpenPullRequestSidePanel:N,onOpenSubagentsPanel:j", "onOpenPullRequestSidePanel:N,onOpenIssuesSidePanel:codexLinuxIssuesOpen,onOpenSubagentsPanel:j");
      return next.replace("onOpenPullRequestSidePanel:N,onOpenSubagentsPanel:j", "onOpenPullRequestSidePanel:N,onOpenIssuesSidePanel:codexLinuxIssuesOpen,onOpenSubagentsPanel:j");
    });
    if (!kuResult.matched || kuResult.source === patched) return driftResult("local conversation root callback anchor did not match");
    patched = kuResult.source;
    fs.writeFileSync(modern.filePath, patched, "utf8");
    return { matched: true, changed: 1 };
  }
  const result = findOne(entries, ({ source }) => source.includes("function cl(") && source.includes("function du(") && source.includes("function fu(") && source.includes("pull-request:"), "local conversation side-panel assets");
  if (result.error) return driftResult(result.error);
  const entry = result.entry;
  if (entry.source.includes(ISSUES_SIDE_PANEL_MARKER)) return { matched: true, changed: 0 };
  const icon = findCircleDotImport(entries);
  if (icon == null) return driftResult("no unique circle-dot icon asset found for Issues side panel");
  const clRange = findFunctionRange(entry.source, "cl");
  if (clRange == null) return driftResult("Pull Request side-panel opener anchor did not match");
  const clBody = entry.source.slice(clRange.start, clRange.end);
  const reactAlias = entry.source.match(/\bvar ([A-Za-z_$][\w$]*),/)?.[1];
  const locationAlias = clBody.match(/\b([A-Za-z_$][\w$]*)\(e,o\)\?\?a/)?.[1];
  const openTabs = clBody.match(/\b([A-Za-z_$][\w$]*)\(s\)\.openTab\(e,([A-Za-z_$][\w$]*)/)?.slice(1);
  const activateAlias = clBody.match(/\b([A-Za-z_$][\w$]*)\(e,s\)/)?.[1];
  if (reactAlias == null || locationAlias == null || openTabs == null || activateAlias == null) {
    return driftResult("Pull Request side-panel aliases did not match");
  }
  const [openTabsAlias, pullRequestTab] = openTabs;
  let patched = `import codexLinuxGithubIssuesIcon from \"./${icon.name}\";${entry.source}`;
  const opener = `const codexLinuxGithubIssuesPanel=${reactAlias}.lazy(()=>import(\`/github-issues-tab.mjs\`).then(issuesModule=>({default:issuesModule.createIssuesSidePanel({React:${reactAlias},components:{},openExternal:url=>{try{void Promise.resolve(window.electronBridge?.openExternal?.(url)).catch(()=>{})}catch{}}})})));function ${ISSUES_SIDE_PANEL_MARKER}(scope){const side=${locationAlias}(scope,\`issues\`)??\`right\`;${openTabsAlias}(side).openTab(scope,codexLinuxGithubIssuesPanel,{activate:!0,defaultState:()=>({}),icon:${reactAlias}.createElement(codexLinuxGithubIssuesIcon,{className:\`icon-xs shrink-0\`}),id:\`issues\`,props:{},title:\`Issues\`,tooltip:\`Issues\`});${activateAlias}(scope,side);return!0}`;
  const clIndex = patched.indexOf("function cl(");
  patched = `${patched.slice(0, clIndex)}${opener}${patched.slice(clIndex)}`;
  const duResult = patchFunctionBody(patched, "du", (body) => {
    const callback = `onOpenIssuesSidePanel:()=>{${ISSUES_SIDE_PANEL_MARKER}(n,{hostId:s})}`;
    return body.replace(/onOpenPullRequestSidePanel:S,onOpenSubagentsPanel:x/g, `onOpenPullRequestSidePanel:S,${callback},onOpenSubagentsPanel:x`);
  });
  if (!duResult.matched || duResult.source === patched) return driftResult("local conversation du callback anchor did not match");
  patched = duResult.source;
  const fuResult = patchFunctionBody(patched, "fu", (body) => {
    const withBinding = addIssuesCallbackBinding(body);
    if (withBinding == null) return body;
    return addIssuesCallbackToCall(withBinding, "yo");
  });
  if (!fuResult.matched || fuResult.source === patched) return driftResult("local conversation fu callback anchor did not match");
  patched = fuResult.source;
  if (!patched.includes(`onOpenIssuesSidePanel:()=>{${ISSUES_SIDE_PANEL_MARKER}`) || !patched.includes("onOpenIssuesSidePanel:codexLinuxIssuesOpen")) return driftResult("local conversation Issues callback anchors did not match");
  fs.writeFileSync(entry.filePath, patched, "utf8");
  return { matched: true, changed: 1 };
}

function patchIssuesNavigationAssets(extractedDir) {
  const { entries } = readWebviewAssets(extractedDir);
  if (!entries.some(({ source }) => source.includes(ISSUES_ROUTE_MARKER))) {
    return { matched: false, changed: 0, reason: "GitHub Issues route marker is absent" };
  }
  if (entries.some(({ source }) => source.includes(ISSUES_NAV_MARKER))) {
    return { matched: true, changed: 0 };
  }
  const navResult = findOne(
    entries,
    ({ source }) => source.includes("sidebarElectron.pullRequestsRouteNavLink") && source.includes("/pull-requests"),
    "Pull Requests navigation assets",
  );
  if (navResult.error) return { matched: false, changed: 0, reason: navResult.error };
  const navEntry = navResult.entry;
  const navShape = captureNavShape(navEntry.source);
  const icon = findCircleDotImport(entries);
  if (navShape == null || icon == null) {
    const reason = navShape == null ? "Pull Requests navigation anchor did not match" : "no unique circle-dot icon asset found";
    return { matched: false, changed: 0, reason };
  }
  const jsxAlias = navShape.block.match(/^\(0,([A-Za-z_$][\w$]*)\.jsx\)/)?.[1];
  if (jsxAlias == null) return { matched: false, changed: 0, reason: "navigation JSX anchor did not match" };
  const importMarker = "codexLinuxGithubIssuesIcon";
  let patched = navEntry.source;
  if (!patched.includes(importMarker)) {
    const importSource = `import ${importMarker} from \"./${icon.name}\";`;
    patched = importSource + patched;
  }
  const issuesBlock = navShape.block
    .replace(/icon:[^,]+/, `icon:${importMarker}`)
    .replace(/onClick:\(\)=>\{[^{}]*\}/, `onClick:()=>{${navShape.navigateAlias}(\`/issues\`)}`)
    .replaceAll("/pull-requests", "/issues")
    .replace("sidebarElectron.pullRequestsRouteNavLink", ISSUES_NAV_MARKER)
    .replace("defaultMessage:`Pull requests`", "defaultMessage:`Issues`")
    .replace("description:`Nav link that opens the pull requests route`", "description:`Nav link that opens the Issues route`");
  const sourceOffset = patched.length - navEntry.source.length;
  const navContainer = captureNavContainer(navEntry.source, navShape);
  if (navContainer == null) {
    patched = `${patched.slice(0, navShape.end + sourceOffset)},${issuesBlock}${patched.slice(navShape.end + sourceOffset)}`;
  } else {
    const issuesContainer = `${navContainer.condition}?(0,${navContainer.jsxAlias}.jsx)(${navContainer.component},{electron:!0,children:${issuesBlock}}):null`;
    patched = `${patched.slice(0, navContainer.end + sourceOffset)},${issuesContainer}${patched.slice(navContainer.end + sourceOffset)}`;
  }
  fs.writeFileSync(navEntry.filePath, patched, "utf8");
  return { matched: true, changed: 1 };
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
  patchIssuesNavigationAssets,
  ISSUES_ROUTE_MARKER,
  ISSUES_NAV_MARKER,
  ISSUES_ENVIRONMENT_MARKER,
  ISSUES_SIDE_PANEL_MARKER,
};
