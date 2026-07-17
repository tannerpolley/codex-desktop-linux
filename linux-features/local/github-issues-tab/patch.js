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

const ISSUES_ROUTE_MARKER = "codexLinuxGithubIssuesRouteMarker";
const ISSUES_NAV_MARKER = "sidebarElectron.issuesRouteNavLink";

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
  return {
    entryPrefix: routeEntry[1],
    jsxAlias: routeEntry[2],
    lazyWrapper: lazyMatch[2],
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

  let routeSource = routeEntry.source;
  const lazyExpression = [
    `const ${ISSUES_ROUTE_MARKER}=true;`,
    `const codexLinuxGithubIssuesRoute=${routeShape.lazyWrapper}(async()=>{const [issuesModule,markdownModule]=await Promise.all([import(\`/github-issues-tab.mjs\`),import(\`./${dependencyResult.dependency.actionName}\`)]);const openExternal=url=>window.electronBridge?.openExternal?.(url);return issuesModule.createIssuesRoute({React:${routeShape.react},components:{},Markdown:markdownModule.${dependencyResult.dependency.markdownExport},openExternal})});`,
  ].join("");
  routeSource = lazyExpression + routeSource;
  const patchedRouteMarkerIndex = routeSource.indexOf("path:`/pull-requests`", lazyExpression.length);
  const patchedEntryStart = patchedRouteMarkerIndex - routeShape.entryPrefix.length;
  routeSource = routeSource.slice(0, patchedEntryStart) + `${routeShape.entryPrefix}path:\`/issues\`,element:(0,${routeShape.jsxAlias}.jsx)(codexLinuxGithubIssuesRoute,{})}),` + routeSource.slice(patchedEntryStart);
  if (routeSource !== routeEntry.source) fs.writeFileSync(routeEntry.filePath, routeSource, "utf8");
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
    id: "github-issues-navigation",
    phase: "extracted-app:post-webview",
    order: 20_933,
    ciPolicy: "optional",
    apply: patchIssuesNavigationAssets,
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
  patchIssuesNavigationAssets,
  ISSUES_ROUTE_MARKER,
  ISSUES_NAV_MARKER,
};
