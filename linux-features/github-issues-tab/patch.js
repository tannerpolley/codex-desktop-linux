"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { applyMainBridgePatch, applyPreloadBridgePatch } = require("./bridge-source.js");
const { extractedAppPatch } = require("../../scripts/patches/descriptor.js");

const ROUTE_MARKER = "codexLinuxGithubIssuesRouteMarker";
const SIDEBAR_ID = "codex-linux-github-issues";

function stageRenderer(extractedDir) {
  const target = path.join(extractedDir, "webview", "github-issues-tab.mjs");
  const source = fs.readFileSync(path.join(__dirname, "renderer.mjs"));
  if (fs.existsSync(target) && fs.readFileSync(target).equals(source)) return { changed: 0, target: "webview/github-issues-tab.mjs" };
  fs.writeFileSync(target, source);
  return { changed: 1, target: "webview/github-issues-tab.mjs" };
}

function jsAssets(extractedDir) {
  const root = path.join(extractedDir, "webview", "assets");
  return fs.readdirSync(root).filter((name) => name.endsWith(".js")).map((name) => ({
    name, path: path.join(root, name), source: fs.readFileSync(path.join(root, name), "utf8"),
  }));
}

function matchingClose(source, open, left = "(", right = ")") {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "`" || character === "\"" || character === "'") quote = character;
    else if (character === left) depth += 1;
    else if (character === right && --depth === 0) return index;
  }
  return -1;
}

function patchSidebar(source) {
  if (source.includes(`id:\`${SIDEBAR_ID}\``)) return source;
  const marker = source.indexOf("sidebarElectron.pullRequestsRouteNavLink");
  if (marker === -1) return null;
  const push = source.lastIndexOf(".push(", marker);
  if (push === -1) return null;
  let arrayStart = push - 1;
  while (arrayStart >= 0 && /[A-Za-z0-9_$]/u.test(source[arrayStart])) arrayStart -= 1;
  const array = source.slice(arrayStart + 1, push);
  const close = matchingClose(source, push + 5);
  const current = close === -1 ? "" : source.slice(push, close + 1);
  const icon = current.match(/\bicon:([A-Za-z_$][\w$]*)/u)?.[1];
  const navigate = current.match(/onSelect:\(\)=>\{[A-Za-z_$][\w$]*\([^,]+,([A-Za-z_$][\w$]*)\)\}/u)?.[1];
  const location = current.match(/isCurrentDestination:([A-Za-z_$][\w$]*)\.startsWith/u)?.[1];
  if (!array || !icon || !navigate || !location) return null;
  const item = `${array}.push({id:\`${SIDEBAR_ID}\`,label:\`Issues\`,icon:${icon},visibleByDefault:!0,onSelect:()=>{${navigate}(\`/issues\`)},isCurrentDestination:${location}.startsWith(\`/issues\`),hasUnreadActivity:!1})`;
  return `${source.slice(0, close + 1)},${item}${source.slice(close + 1)}`;
}

function routeShape(source) {
  const route = source.match(/(\(0,([A-Za-z_$][\w$]*)\.jsx\)\([A-Za-z_$][\w$]*,\{)path:`\/pull-requests`/u);
  if (!route) return null;
  const lazyPattern = /(?:\b(?:const|let|var)\s+|[,;])([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\(/gu;
  let lazy = null;
  for (const candidate of source.matchAll(lazyPattern)) {
    if (candidate.index >= route.index) break;
    const open = candidate.index + candidate[0].lastIndexOf("(");
    const close = matchingClose(source, open);
    if (close !== -1 && source.slice(open, close + 1).includes("PullRequestsRoute")) lazy = { match: candidate, open, close };
  }
  if (!lazy) return null;
  const react = [...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\(\),1\)/gu)]
    .filter((match) => match.index < route.index && source.includes(`${match[1]}.Suspense`)).at(-1)?.[1] || route[2];
  return { route, lazy, react };
}

function patchRoute(source) {
  if (source.includes(ROUTE_MARKER)) return source;
  const shape = routeShape(source);
  if (!shape) return null;
  const routeVariable = "codexLinuxGithubIssuesRoute";
  const assignment = `${routeVariable}=${shape.lazy.match[2]}(async()=>(await import(\`/github-issues-tab.mjs\`)).createIssuesRoute({React:${shape.react}}))`;
  let patched = source;
  const declaration = shape.lazy.match[0].match(/^(?:const|let|var)\b/u)?.[0];
  if (declaration) {
    patched = `${patched.slice(0, shape.lazy.match.index)}const ${assignment};${patched.slice(shape.lazy.match.index)}`;
  } else {
    const delimiter = shape.lazy.match[0][0];
    const insert = shape.lazy.match.index + 1;
    const declarationStart = patched.lastIndexOf("var ", shape.lazy.match.index);
    const equals = declarationStart === -1 ? -1 : patched.indexOf("=", declarationStart);
    if (equals === -1) return null;
    patched = `${patched.slice(0, declarationStart + 4)}${routeVariable},${patched.slice(declarationStart + 4)}`;
    const adjusted = insert + routeVariable.length + 1;
    patched = `${patched.slice(0, adjusted)}${assignment}${delimiter}${patched.slice(adjusted)}`;
  }
  const marker = patched.indexOf("path:`/pull-requests`");
  const prefix = shape.route[1];
  const start = marker - prefix.length;
  return `const ${ROUTE_MARKER}=true;${patched.slice(0, start)}${prefix}path:\`/issues\`,element:(0,${shape.route[2]}.jsx)(${routeVariable},{})}),${patched.slice(start)}`;
}

function patchPreload(extractedDir) {
  const root = path.join(extractedDir, ".vite", "build");
  const matches = fs.readdirSync(root).filter((name) => name.endsWith(".js")).filter((name) => {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    return source.includes("exposeInMainWorld") && source.includes("electronBridge");
  });
  if (matches.length !== 1) return { matched: false, changed: 0, reason: `found ${matches.length} preload bundles` };
  const target = path.join(root, matches[0]);
  const source = fs.readFileSync(target, "utf8");
  const patched = applyPreloadBridgePatch(source);
  if (!patched.includes("githubIssues:{request:")) return { matched: false, changed: 0, reason: "preload bridge anchor did not match" };
  if (patched !== source) fs.writeFileSync(target, patched);
  return { matched: true, changed: Number(patched !== source), target: matches[0] };
}

function patchRouteAndSidebar(extractedDir) {
  const assets = jsAssets(extractedDir);
  const routeAsset = assets.find(({ source }) => source.includes("path:`/pull-requests`") && source.includes("PullRequestsRoute"));
  const sidebarAsset = assets.find(({ source }) => source.includes("sidebarElectron.pullRequestsRouteNavLink")
    && source.includes("defaultMessage:`Pull requests`")
    && source.includes(".push({id:"));
  if (!routeAsset || !sidebarAsset) return { matched: false, changed: 0, reason: "Pull Requests route or sidebar anchor was not found" };
  const routeOutput = patchRoute(routeAsset.source);
  if (routeOutput == null) return { matched: false, changed: 0, reason: "Pull Requests route shape did not match" };
  if (routeAsset.path === sidebarAsset.path) {
    const output = patchSidebar(routeOutput);
    if (output == null) return { matched: false, changed: 0, reason: "Pull Requests sidebar shape did not match" };
    if (output !== routeAsset.source) fs.writeFileSync(routeAsset.path, output);
    return { matched: true, changed: Number(output !== routeAsset.source), targets: [routeAsset.name] };
  }
  const sidebarOutput = patchSidebar(sidebarAsset.source);
  if (sidebarOutput == null) return { matched: false, changed: 0, reason: "Pull Requests sidebar shape did not match" };
  if (routeOutput !== routeAsset.source) fs.writeFileSync(routeAsset.path, routeOutput);
  if (sidebarOutput !== sidebarAsset.source) fs.writeFileSync(sidebarAsset.path, sidebarOutput);
  return { matched: true, changed: Number(routeOutput !== routeAsset.source) + Number(sidebarOutput !== sidebarAsset.source), targets: [routeAsset.name, sidebarAsset.name] };
}

function status(result) {
  return result?.matched === false ? { status: "skipped-optional", reason: result.reason } : result?.changed ? "applied" : "already-applied";
}

const descriptors = [
  { id: "github-issues-main-bridge", phase: "main-bundle", order: 20_930, ciPolicy: "optional", apply: applyMainBridgePatch },
  extractedAppPatch({ id: "github-issues-renderer", phase: "extracted-app:post-webview", order: 20_931, ciPolicy: "optional", apply: stageRenderer }),
  { id: "github-issues-preload", phase: "extracted-app:post-webview", order: 20_932, ciPolicy: "optional", apply: patchPreload, status },
  { id: "github-issues-pr-route", phase: "extracted-app:post-webview", order: 20_933, ciPolicy: "optional", apply: patchRouteAndSidebar, status },
];

module.exports = { ROUTE_MARKER, SIDEBAR_ID, descriptors, patchPreload, patchRoute, patchRouteAndSidebar, patchSidebar, stageRenderer };
