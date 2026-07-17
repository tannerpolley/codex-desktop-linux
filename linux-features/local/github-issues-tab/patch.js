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
const ISSUES_DEPENDENCY_MARKER = "codexLinuxGithubIssuesDependencies";
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

function captureSharedIdentifiers(source) {
  const react = source.match(/\b(React)\b/)?.[1]
    ?? source.match(/\b([A-Za-z_$][\w$]*)\.jsx\b/)?.[1]
    ?? null;
  const components = source.match(/\b(components)\b/)?.[1]
    ?? source.match(/\b([A-Za-z_$][\w$]*)\.Button\b/)?.[1]
    ?? null;
  const markdown = source.match(/(?:const|let|var|function)\s+(Markdown)\b/)?.[1] ?? null;
  const openExternal = source.match(/(?:const|let|var)\s+(openExternal)\s*=/)?.[1]
    ?? source.match(/\b([A-Za-z_$][\w$]*)\s*=\s*\([^)]*href[^)]*\)\s*=>/)?.[1]
    ?? null;
  if (react == null || components == null || markdown == null || openExternal == null) return null;
  return { React: react, components, Markdown: markdown, openExternal };
}

function capturePullRequestDetailIdentifiers(source) {
  const react = source.match(/\(0,([A-Za-z_$][\w$]*)\.jsx\)/)?.[1] ?? null;
  const markdown = source.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{account:[^}]{0,120}?allowBasicHtml:!0/)?.[1] ?? null;
  const components = source.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{actions:/)?.[1] ?? null;
  const openExternal = source.match(/\b([A-Za-z_$][\w$]*)\(\{event:[^}]{0,160}?href:/)?.[1] ?? null;
  if (react == null || components == null || markdown == null || openExternal == null) return null;
  return { React: react, components, Markdown: markdown, openExternal };
}

function captureCurrentSharedIdentifiers(source) {
  if (!source.includes("function XH(") || !source.includes("const openExternal") || !source.includes("var ZH")) return null;
  return { React: "ZH", components: "C", Markdown: "XH", openExternal: "openExternal" };
}

function captureRouteShape(source) {
  const lazyPattern = /(?:\b(?:const|let|var)\s+|[,;])([A-Za-z_$][\w$]*)\s*=\s*(?:(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*)\(/g;
  let lazyMatch = null;
  for (const candidate of source.matchAll(lazyPattern)) {
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
      break;
    }
  }
  if (lazyMatch == null) return null;
  const routeEntry = source.match(/(\(0,([A-Za-z_$][\w$]*)\.jsx\)\([A-Za-z_$][\w$]*,\{)path:`\/pull-requests`/);
  if (routeEntry == null) return null;
  return {
    entryPrefix: routeEntry[1],
    jsxAlias: routeEntry[2],
  };
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
  return { start, end, block };
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
  let dependencyResult = findOne(
    entries,
    ({ source }) => captureSharedIdentifiers(source) != null
      && /\bMarkdown\s*\(/.test(source)
      && /\bopenExternal\s*\(/.test(source),
    "Pull Requests shared dependency assets",
  );
  let dependencyEntry;
  let dependencies;
  if (dependencyResult.error) {
    const currentSharedResult = findOne(
      entries,
      ({ source }) => captureCurrentSharedIdentifiers(source) != null,
      "current shared renderer dependency assets",
    );
    if (!currentSharedResult.error) {
      dependencyEntry = currentSharedResult.entry;
      dependencies = captureCurrentSharedIdentifiers(dependencyEntry.source);
    } else {
      dependencyResult = findOne(
        entries,
        ({ source }) => source.includes("allowBasicHtml:!0")
          && source.includes("useExternalBrowser:!0")
          && source.includes("PullRequestsRoute"),
        "Pull Requests detail dependency assets",
      );
      if (dependencyResult.error) return driftResult(dependencyResult.error);
      dependencyEntry = dependencyResult.entry;
      dependencies = capturePullRequestDetailIdentifiers(dependencyEntry.source);
    }
  } else {
    dependencyEntry = dependencyResult.entry;
    dependencies = captureSharedIdentifiers(dependencyEntry.source);
  }
  const routeShape = captureRouteShape(routeEntry.source);
  if (dependencies == null) return driftResult("shared React, components, Markdown, or external-link anchors did not match");
  if (routeShape == null) return driftResult("Pull Requests lazy route or route-table anchor did not match");

  const routeAlreadyApplied = routeEntry.source.includes(ISSUES_ROUTE_MARKER);
  const depAlreadyApplied = dependencyEntry.source.includes(ISSUES_DEPENDENCY_MARKER);
  if (routeAlreadyApplied && depAlreadyApplied) return { matched: true, changed: 0 };

  const staged = new Map();
  let routeSource = routeEntry.source;
  if (!routeAlreadyApplied) {
    const lazyExpression = [
      `const ${ISSUES_ROUTE_MARKER}=true;`,
      `const codexLinuxGithubIssuesRoute=(()=>{const {React,components,Markdown,openExternal}=globalThis.${ISSUES_DEPENDENCY_MARKER};return React.lazy(()=>import(\`/github-issues-tab.mjs\`).then(m=>({default:m.createIssuesRoute({React,components,Markdown,openExternal})})))})();`,
    ].join("");
    routeSource = lazyExpression + routeSource;
    const patchedRouteMarkerIndex = routeSource.indexOf("path:`/pull-requests`", lazyExpression.length);
    const patchedEntryStart = patchedRouteMarkerIndex - routeShape.entryPrefix.length;
    routeSource = routeSource.slice(0, patchedEntryStart) + `${routeShape.entryPrefix}path:\`/issues\`,element:(0,${routeShape.jsxAlias}.jsx)(codexLinuxGithubIssuesRoute,{})}),` + routeSource.slice(patchedEntryStart);
    staged.set(routeEntry.filePath, routeSource);
  }

  if (!depAlreadyApplied) {
    const depSource = dependencyEntry.source;
    const dependencyExpression = `;globalThis.${ISSUES_DEPENDENCY_MARKER}=globalThis.${ISSUES_DEPENDENCY_MARKER}||{React:${dependencies.React},components:${dependencies.components},Markdown:${dependencies.Markdown},openExternal:${dependencies.openExternal}};`;
    const patchedDependency = dependencyEntry.filePath === routeEntry.filePath
      ? dependencyExpression + routeSource
      : depSource + dependencyExpression;
    staged.set(dependencyEntry.filePath, patchedDependency);
  }
  for (const [filePath, patchedSource] of staged) {
    if (patchedSource !== fs.readFileSync(filePath, "utf8")) fs.writeFileSync(filePath, patchedSource, "utf8");
  }
  return { matched: true, changed: staged.size };
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
    .replaceAll("/pull-requests", "/issues")
    .replace("sidebarElectron.pullRequestsRouteNavLink", ISSUES_NAV_MARKER)
    .replace("defaultMessage:`Pull requests`", "defaultMessage:`Issues`")
    .replace("description:`Nav link that opens the pull requests route`", "description:`Nav link that opens the Issues route`");
  const sourceOffset = patched.length - navEntry.source.length;
  patched = `${patched.slice(0, navShape.start + sourceOffset)}${issuesBlock}${patched.slice(navShape.end + sourceOffset)};/*${ISSUES_NAV_MARKER}*/`;
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
  ISSUES_DEPENDENCY_MARKER,
  ISSUES_NAV_MARKER,
};
