# GitHub Issues Tab Local Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a branch-local, read-only GitHub Issues inbox beside Pull Requests with Assigned, Authored, and All views plus a full Issue timeline.

**Architecture:** A current-DMG renderer patch adds the nav item and route, while a preload/main-process patch exposes one validated `window.electronBridge.githubIssues.request` method. The main process runs a staged Node adapter that owns fixed `gh api graphql` documents and returns normalized JSON over stdio; credentials never enter the renderer.

**Tech Stack:** Node.js 22 built-ins, `node:test`, Electron IPC/context bridge, React supplied by the current renderer bundle, GitHub CLI 2.45+, GitHub GraphQL API, Linux feature descriptors.

## Global Constraints

- All implementation files live under normally gitignored `linux-features/local/github-issues-tab/` and are intentionally force-added to this local feature branch for task commits and reviews.
- Do not push this branch or create a PR without separate user authorization.
- The feature id is exactly `github-issues-tab`, `defaultEnabled` is `false`, and `features.example.json` remains unchanged.
- The route is read-only: no task-start or GitHub mutation control may be rendered or exposed by the bridge.
- The adapter owns every GraphQL document and invokes `gh` with `spawn`/`execFile`, never a shell.
- Support GitHub.com and GitHub Enterprise through the selected authenticated hostname and resolved viewer login; never expose or log a token.
- Patch descriptors are optional, idempotent, current-DMG-only, and fail soft when a semantic anchor is missing or ambiguous.
- Substantial renderer and adapter logic stays in focused files, not one injected string in `patch.js`.
- Unknown timeline event types render generically; missing optional fields never discard the remaining Issue or timeline.
- Run `bash /home/tnnrpolley21/.codex/hooks/codex-cleanup.sh --repo-root .` after task-owned builds/tests.

## File map

- Create `linux-features/local/github-issues-tab/README.md`: local enablement, limitations, current-DMG pin, and commands.
- Create `linux-features/local/github-issues-tab/feature.json`: disabled manifest, descriptors, and staged resources.
- Create `linux-features/local/github-issues-tab/protocol.js`: request/response enums, size limits, and validators shared by adapter and bridge-source tests.
- Create `linux-features/local/github-issues-tab/issues-adapter.js`: stdin CLI, `gh` execution, fixed GraphQL operations, normalization, and cancellation.
- Create `linux-features/local/github-issues-tab/bridge-source.js`: small source generators injected into preload/main bundles.
- Create `linux-features/local/github-issues-tab/renderer.mjs`: pure route state plus the React Issues inbox/detail UI factory.
- Create `linux-features/local/github-issues-tab/patch.js`: descriptor discovery, exact-match patching, staged renderer dependency wiring, and reporting.
- Create `linux-features/local/github-issues-tab/test.js`: manifest, descriptor, bridge, route-state, and drift tests.
- Create `linux-features/local/github-issues-tab/issues-adapter.test.js`: adapter/query/normalization/process tests.
- Create `linux-features/local/github-issues-tab/fixtures/*.json`: GraphQL capabilities, list, detail, partial-error, and timeline fixtures.
- Create `linux-features/local/github-issues-tab/VALIDATION.md`: current-DMG commands and observed acceptance evidence.
- Modify `linux-features/features.json`: enable only `github-issues-tab` for the local rebuild.

---

### Task 1: Establish the local feature and protocol contract

**Files:**
- Create: `linux-features/local/github-issues-tab/README.md`
- Create: `linux-features/local/github-issues-tab/feature.json`
- Create: `linux-features/local/github-issues-tab/protocol.js`
- Create: `linux-features/local/github-issues-tab/test.js`

**Interfaces:**
- Produces: `OPERATIONS`, `VIEWS`, `STATES`, `LIMITS`, `validateEnvelope(value)`, and `validateResponse(value)` from `protocol.js`.
- Consumes: the repository Linux-feature manifest contract only.

- [ ] **Step 1: Write the failing manifest and protocol tests**

Add tests that require the manifest below and assert the exact resources, then require `protocol.js` and exercise valid and invalid envelopes:

```js
test("local Issues feature stays disabled and stages only owned resources", () => {
  assert.equal(manifest.id, "github-issues-tab");
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.entrypoints, { patchDescriptors: "./patch.js" });
  assert.deepEqual(manifest.resources, [
    { source: "issues-adapter.js", target: ".codex-linux/features/github-issues-tab/issues-adapter.js", mode: "0644" },
    { source: "protocol.js", target: ".codex-linux/features/github-issues-tab/protocol.js", mode: "0644" },
    { source: "renderer.mjs", target: "content/webview/github-issues-tab.mjs", mode: "0644" },
  ]);
});

test("protocol accepts a bounded list request and rejects supplied GraphQL", () => {
  assert.deepEqual(validateEnvelope({
    version: 1,
    requestId: "req-1",
    operation: "listIssues",
    input: { host: "github.com", view: "assigned", state: "open", repository: null, text: "parser", cursor: null },
  }).operation, "listIssues");
  assert.throws(() => validateEnvelope({
    version: 1,
    requestId: "req-2",
    operation: "listIssues",
    input: { host: "github.com", view: "assigned", state: "open", query: "mutation { deleteIssue }" },
  }), /unknown field: query/);
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run: `node --test linux-features/local/github-issues-tab/test.js`

Expected: FAIL because `feature.json` and `protocol.js` do not exist.

- [ ] **Step 3: Add the disabled manifest and README**

Use this manifest exactly:

```json
{
  "id": "github-issues-tab",
  "title": "GitHub Issues Tab",
  "description": "Local read-only GitHub Issues inbox and timeline beside Pull Requests.",
  "defaultEnabled": false,
  "entrypoints": { "patchDescriptors": "./patch.js" },
  "resources": [
    { "source": "issues-adapter.js", "target": ".codex-linux/features/github-issues-tab/issues-adapter.js", "mode": "0644" },
    { "source": "protocol.js", "target": ".codex-linux/features/github-issues-tab/protocol.js", "mode": "0644" },
    { "source": "renderer.mjs", "target": "content/webview/github-issues-tab.mjs", "mode": "0644" }
  ]
}
```

The README must state: current-DMG-only, local/ignored, GitHub CLI auth required, read-only behavior, the enablement JSON, the explicit test commands, and the disable/rebuild procedure.

- [ ] **Step 4: Implement strict protocol validation**

Define these exact constants and return a cloned normalized envelope:

```js
const OPERATIONS = new Set(["capabilities", "listIssues", "getIssue", "getIssueTimelinePage", "cancel"]);
const VIEWS = new Set(["assigned", "authored", "all"]);
const STATES = new Set(["open", "closed", "all"]);
const LIMITS = Object.freeze({ requestId: 96, host: 253, repository: 200, text: 500, cursor: 512, nodeId: 256 });
```

Reject arrays, prototypes other than `Object.prototype`/`null`, unknown fields, control characters, overlong strings, invalid hostnames, invalid `owner/name`, invalid enums, and operation-specific missing fields. `capabilities` accepts `{host}` with a nullable host, `cancel` accepts only `{targetRequestId}`, `getIssue` accepts `{host,nodeId}`, and timeline continuation additionally accepts `{cursor}`.

- [ ] **Step 5: Run the protocol and manifest tests**

Run: `node --test linux-features/local/github-issues-tab/test.js`

Expected: PASS for the manifest and protocol tests.

- [ ] **Step 6: Commit the feature contract**

Run:

```bash
git add -f linux-features/local/github-issues-tab/README.md linux-features/local/github-issues-tab/feature.json linux-features/local/github-issues-tab/protocol.js linux-features/local/github-issues-tab/test.js
git commit -m "feat: define local GitHub Issues feature contract"
```

Expected: commit succeeds; `linux-features/features.json` remains ignored and unstaged.

---

### Task 2: Build the read-only GitHub adapter list path

**Files:**
- Create: `linux-features/local/github-issues-tab/issues-adapter.js`
- Create: `linux-features/local/github-issues-tab/issues-adapter.test.js`
- Create: `linux-features/local/github-issues-tab/fixtures/capabilities.json`
- Create: `linux-features/local/github-issues-tab/fixtures/list-assigned.json`
- Create: `linux-features/local/github-issues-tab/fixtures/partial-list.json`

**Interfaces:**
- Consumes: `validateEnvelope` and `LIMITS` from `protocol.js`.
- Produces: `buildSearchQuery(input, viewerLogin)`, `normalizeIssue(node, host)`, `runOperation(envelope, deps)`, and CLI JSON responses shaped as `{version:1,requestId,ok,data,error}`.

- [ ] **Step 1: Write failing tests for search semantics and normalization**

```js
test("buildSearchQuery creates account-scoped inbox searches", () => {
  assert.equal(buildSearchQuery({ view: "assigned", state: "open", repository: null, text: "" }, "octocat"), "is:issue assignee:octocat is:open sort:updated-desc");
  assert.equal(buildSearchQuery({ view: "authored", state: "closed", repository: "openai/codex", text: "race" }, "octocat"), "is:issue author:octocat is:closed repo:openai/codex race sort:updated-desc");
  assert.equal(buildSearchQuery({ view: "all", state: "all", repository: null, text: "" }, "octocat"), "is:issue involves:octocat sort:updated-desc");
});

test("normalizeIssue removes GraphQL shape from renderer data", () => {
  const issue = normalizeIssue(fixture.data.search.nodes[0], "github.com");
  assert.deepEqual(Object.keys(issue).sort(), ["assignees","author","commentCount","createdAt","host","id","labels","milestone","number","repository","state","stateReason","title","updatedAt","url"]);
});
```

- [ ] **Step 2: Verify the adapter tests fail**

Run: `node --test linux-features/local/github-issues-tab/issues-adapter.test.js`

Expected: FAIL because the adapter exports do not exist.

- [ ] **Step 3: Implement process execution without a shell**

Use `spawn(ghPath, ["api", "graphql", "--hostname", host, "--input", "-"], {stdio:["pipe","pipe","pipe"]})`. Write `{query,variables}` JSON to stdin, cap stdout at 8 MiB and stderr at 64 KiB, use a 30-second list/capabilities timeout and a 60-second detail timeout, and reject with sanitized categories: `gh-missing`, `auth-required`, `unauthorized`, `offline`, `rate-limited`, `invalid-response`, or `adapter-failed`.

- [ ] **Step 4: Implement fixed capabilities and list documents**

The capabilities query is:

```graphql
query CodexLinuxIssuesCapabilities { viewer { login } rateLimit { cost remaining resetAt } }
```

The list query uses `search(query:$search,type:ISSUE,first:30,after:$cursor)` and selects `id`, `number`, `title`, `url`, `state`, `stateReason`, timestamps, author, repository, labels(first:20), assignees(first:10), milestone, and `comments { totalCount }`, plus `pageInfo` and `rateLimit`.

Resolve authenticated hosts with `gh auth status --json hosts`; select the requested authenticated host or the active entry. Never call `gh auth token` and never pass `--show-token`.

- [ ] **Step 5: Implement list normalization and partial-data behavior**

Return:

```js
{
  host,
  viewerLogin,
  issues,
  pageInfo: { hasNextPage, endCursor },
  rateLimit: { cost, remaining, resetAt },
  warnings: errors.map(({ type, path }) => ({ type, path: Array.isArray(path) ? path : [] })),
}
```

Deduplicate Issues by `id`, preserve usable `data` when GraphQL also returns `errors`, and never include raw response bodies in an error.

- [ ] **Step 6: Run list-path tests, including literal metacharacter input**

Add a fake `spawn` that records argv/stdin and test the text `$(touch nope); "quoted"` remains inside the GraphQL variable JSON and never appears in a shell command.

Run: `node --test linux-features/local/github-issues-tab/issues-adapter.test.js`

Expected: PASS for capabilities, three views, filters, pagination, partial data, process limits, and safe argv handling.

- [ ] **Step 7: Commit the Issue list adapter**

Run:

```bash
git add -f linux-features/local/github-issues-tab/issues-adapter.js linux-features/local/github-issues-tab/issues-adapter.test.js linux-features/local/github-issues-tab/fixtures/capabilities.json linux-features/local/github-issues-tab/fixtures/list-assigned.json linux-features/local/github-issues-tab/fixtures/partial-list.json
git commit -m "feat: add GitHub Issues list adapter"
```

Expected: commit succeeds with only Task 2 files.

---

### Task 3: Add Issue detail and full timeline normalization

**Files:**
- Modify: `linux-features/local/github-issues-tab/issues-adapter.js`
- Modify: `linux-features/local/github-issues-tab/issues-adapter.test.js`
- Create: `linux-features/local/github-issues-tab/fixtures/issue-detail.json`
- Create: `linux-features/local/github-issues-tab/fixtures/timeline-page-2.json`
- Create: `linux-features/local/github-issues-tab/fixtures/timeline-partial.json`

**Interfaces:**
- Consumes: the adapter execution and response envelope from Task 2.
- Produces: `normalizeTimelineItem(node, host)`, `getIssue`, and `getIssueTimelinePage` results.

- [ ] **Step 1: Write failing table tests for every required event type**

Use fixture nodes for `IssueComment`, `LabeledEvent`, `UnlabeledEvent`, `AssignedEvent`, `UnassignedEvent`, `MilestonedEvent`, `DemilestonedEvent`, `ClosedEvent`, `ReopenedEvent`, `RenamedTitleEvent`, `ReferencedEvent`, `CrossReferencedEvent`, `TransferredEvent`, and `FutureIssueEvent`.

```js
for (const [type, expectedKind] of cases) {
  test(`normalizes ${type}`, () => {
    assert.equal(normalizeTimelineItem(byType[type], "github.com").kind, expectedKind);
  });
}
test("unknown timeline nodes retain type and time", () => {
  assert.deepEqual(normalizeTimelineItem(byType.FutureIssueEvent, "github.com"), {
    id: "future-1", kind: "generic", type: "FutureIssueEvent", createdAt: "2026-07-17T00:00:00Z", actor: null,
  });
});
```

- [ ] **Step 2: Verify the timeline tests fail**

Run: `node --test --test-name-pattern='timeline|normalizes' linux-features/local/github-issues-tab/issues-adapter.test.js`

Expected: FAIL because timeline normalization is absent.

- [ ] **Step 3: Add the fixed detail GraphQL document**

Query `node(id:$nodeId) { ... on Issue { ...metadata body timelineItems(first:50,after:$cursor) { nodes { __typename ...known fragments } pageInfo { hasNextPage endCursor } } } }` and `rateLimit`. Request `body` Markdown, not untrusted pre-rendered HTML. Every known fragment selects only fields used by the normalized timeline model; all nodes select `__typename` and an identifier/time where the schema permits.

- [ ] **Step 4: Normalize the detail and timeline contract**

Return detail as:

```js
{
  issue: { ...summary, body, projects },
  timeline: { items, pageInfo: { hasNextPage, endCursor } },
  rateLimit,
  warnings,
}
```

Use discriminated `kind` values `comment`, `label`, `assignment`, `milestone`, `state`, `rename`, `reference`, `transfer`, and `generic`. Normalize actor/user/repository/reference shapes once, append pages chronologically, and deduplicate by `id` in the renderer model.

- [ ] **Step 5: Cover deleted users, private references, missing fields, and partial errors**

Assert a missing actor becomes `null`, a private reference becomes a reference event with `target:null`, absent milestone/assignee data does not throw, and partial GraphQL errors populate `warnings` while retaining timeline items.

- [ ] **Step 6: Run the complete adapter suite**

Run: `node --test linux-features/local/github-issues-tab/issues-adapter.test.js`

Expected: all adapter tests PASS with no network calls.

- [ ] **Step 7: Commit Issue detail and timeline support**

Run:

```bash
git add -f linux-features/local/github-issues-tab/issues-adapter.js linux-features/local/github-issues-tab/issues-adapter.test.js linux-features/local/github-issues-tab/fixtures/issue-detail.json linux-features/local/github-issues-tab/fixtures/timeline-page-2.json linux-features/local/github-issues-tab/fixtures/timeline-partial.json
git commit -m "feat: render GitHub Issue timeline data"
```

Expected: commit succeeds with only Task 3 files.

---

### Task 4: Add the validated preload/main-process bridge

**Files:**
- Create: `linux-features/local/github-issues-tab/bridge-source.js`
- Modify: `linux-features/local/github-issues-tab/patch.js`
- Modify: `linux-features/local/github-issues-tab/test.js`

**Interfaces:**
- Consumes: request envelopes from `protocol.js` and the staged adapter path.
- Produces: `preloadBridgeProperty(ipcRendererSymbol)`, `mainBridgeSource()`, `applyPreloadBridgePatch(source)`, and `applyMainBridgePatch(source)`.

- [ ] **Step 1: Write failing synthetic-bundle tests**

```js
test("preload patch exposes one namespaced request method", () => {
  const source = "bridge.exposeInMainWorld(`electronBridge`,{openExternal:e=>ipc.invoke(`open-external`,e),getSentryInitOptions:()=>opts})";
  const once = applyPreloadBridgePatch(source);
  assert.match(once, /githubIssues:\{request:e=>ipc\.invoke\(`codex-linux:github-issues`,e\)\}/);
  assert.equal(applyPreloadBridgePatch(once), once);
});

test("main patch registers one handler and adapter runner", () => {
  const source = "electron.ipcMain.handle(`codex_desktop:check-for-updates`,async e=>{});";
  const once = applyMainBridgePatch(source);
  assert.match(once, /codex-linux:github-issues/);
  assert.match(once, /issues-adapter\.js/);
  assert.equal(applyMainBridgePatch(once), once);
});
```

- [ ] **Step 2: Verify bridge tests fail**

Run: `node --test --test-name-pattern='preload|main patch' linux-features/local/github-issues-tab/test.js`

Expected: FAIL because bridge source/patch functions are absent.

- [ ] **Step 3: Implement the preload property patch**

Anchor on the unique `electronBridge` exposure containing `getSentryInitOptions`, capture the IPC renderer identifier from an adjacent `.invoke(...)`, and insert exactly:

```js
githubIssues:{request:e=>IPC.invoke(`codex-linux:github-issues`,e)},
```

Require one semantic match. If zero or multiple matches occur, warn and return the original source.

- [ ] **Step 4: Implement the main-process handler source**

The injected helper must:

- validate the top-level version/request id/operation/shape before spawning;
- resolve `resources/node-runtime/bin/node` and `../.codex-linux/features/github-issues-tab/issues-adapter.js` from `process.resourcesPath`;
- run one adapter per request with JSON on stdin and an 8 MiB stdout limit;
- track children in `Map<requestId,ChildProcess>`;
- handle `cancel` by terminating only the mapped child;
- enforce 30/60-second timeouts and remove the map entry in `finally`;
- return a sanitized `{version,requestId,ok,data,error}` object rather than throwing raw process errors.

Register it once on `codex-linux:github-issues` beside an existing trusted `ipcMain.handle` anchor. Do not add a general command channel.

- [ ] **Step 5: Add extracted-app preload discovery**

Use an `extracted-app:post-webview` descriptor that walks only the extracted app's `.vite/build` JavaScript files, selects the unique file containing both `exposeInMainWorld` and `electronBridge`, patches it atomically in memory, and returns `{matched,changed}`. Its `status` maps unmatched drift to `skipped-optional`.

- [ ] **Step 6: Test invalid input, cancellation, limits, and drift**

Evaluate the generated main helper in `node:vm` with fake `require`, `process.resourcesPath`, `ipcMain`, and child processes. Assert unknown operations never spawn, duplicate request ids reject, cancellation kills only the owned child, oversized output rejects, and missing/ambiguous anchors preserve source with warnings.

- [ ] **Step 7: Run bridge and descriptor tests**

Run: `node --test linux-features/local/github-issues-tab/test.js`

Expected: all protocol, manifest, bridge, idempotence, and drift tests PASS.

- [ ] **Step 8: Commit the Electron bridge**

Run:

```bash
git add -f linux-features/local/github-issues-tab/bridge-source.js linux-features/local/github-issues-tab/patch.js linux-features/local/github-issues-tab/test.js
git commit -m "feat: bridge GitHub Issues through Electron"
```

Expected: commit succeeds with only Task 4 files.

---

### Task 5: Build the renderer state model and read-only UI

**Files:**
- Create: `linux-features/local/github-issues-tab/renderer.mjs`
- Modify: `linux-features/local/github-issues-tab/test.js`

**Interfaces:**
- Consumes: `deps = {React, components, Markdown, openExternal}` and `window.electronBridge.githubIssues.request(envelope)`.
- Produces: `initialIssuesState()`, `issuesReducer(state, action)`, `mergeTimeline(existing,incoming)`, and `createIssuesRoute(deps)`.

- [ ] **Step 1: Write failing pure-state tests**

Import `renderer.mjs` dynamically and test:

```js
test("stale list and detail responses cannot replace current state", () => {
  let state = initialIssuesState();
  state = issuesReducer(state, { type: "list-start", requestId: "list-2" });
  assert.equal(issuesReducer(state, { type: "list-success", requestId: "list-1", data: { issues: [] } }), state);
  state = issuesReducer(state, { type: "select", issueId: "I_2", requestId: "detail-2" });
  assert.equal(issuesReducer(state, { type: "detail-success", requestId: "detail-1", data: {} }), state);
});

test("timeline pages append chronologically without duplicates", () => {
  assert.deepEqual(mergeTimeline([{id:"a",createdAt:"2026-01-01"}], [{id:"a",createdAt:"2026-01-01"},{id:"b",createdAt:"2026-01-02"}]).map(x=>x.id), ["a","b"]);
});
```

- [ ] **Step 2: Verify the renderer-model tests fail**

Run: `node --test --test-name-pattern='stale|timeline pages' linux-features/local/github-issues-tab/test.js`

Expected: FAIL because `renderer.mjs` does not exist.

- [ ] **Step 3: Implement reducer, request ids, and bridge client**

State keys are `host`, `viewerLogin`, `view`, `stateFilter`, `repository`, `text`, `list`, `listPage`, `selectedId`, `detail`, `timeline`, `capabilities`, and per-operation `{requestId,status,error,warnings}`. Generate request ids with `crypto.randomUUID()`, cancel superseded ids through the same bridge, and ignore every response whose id is no longer current.

- [ ] **Step 4: Implement the PR-like inbox shell**

`createIssuesRoute(deps)` returns a React component using only supplied React/shared dependencies. Render Assigned/Authored/All controls; Open/Closed/All state; repository/text inputs; refresh; list rows; loading, empty, partial, and typed error states; forward pagination; and a persistent detail pane. Every interactive element has a visible focus state and accessible label.

Rows show repository, number, title, state, labels, author, assignees, comment count, and relative update time. The active hostname is always visible.

- [ ] **Step 5: Implement read-only body and timeline rendering**

Use the supplied existing Markdown component for the Issue body and comment bodies. Map normalized timeline `kind` values to compact event rows; `generic` renders its `type` and time. Use the supplied existing external-link function for Issue/repository/user/reference URLs. Do not render any button/menu labeled Start task, Comment, Close, Reopen, Assign, Label, Edit, or Delete.

- [ ] **Step 6: Add renderer-state and static safety assertions**

Assert all loading/error/partial/populated reducer transitions, host invalidation, pagination append, selection preservation on refresh, and generic events. Read `renderer.mjs` as text and assert it contains the three views and no mutation/task labels or direct `gh`, `child_process`, token, `innerHTML`, or `shell.openExternal` access.

- [ ] **Step 7: Run renderer tests and syntax import**

Run: `node --test linux-features/local/github-issues-tab/test.js`

Expected: all renderer state and static safety tests PASS; dynamic import parses without a DOM.

- [ ] **Step 8: Commit the Issues renderer**

Run:

```bash
git add -f linux-features/local/github-issues-tab/renderer.mjs linux-features/local/github-issues-tab/test.js
git commit -m "feat: add read-only GitHub Issues renderer"
```

Expected: commit succeeds with only Task 5 files.

---

### Task 6: Attach navigation, route, and shared renderer dependencies

**Files:**
- Modify: `linux-features/local/github-issues-tab/patch.js`
- Modify: `linux-features/local/github-issues-tab/test.js`

**Interfaces:**
- Consumes: `createIssuesRoute(deps)` from staged `/github-issues-tab.mjs` and the current Pull Requests/shared renderer symbols.
- Produces: `patchIssuesRouteAssets(extractedDir)` and `patchIssuesNavigationAssets(extractedDir)` plus separate optional post-webview descriptor statuses.

- [ ] **Step 1: Capture bounded current-DMG fixtures**

From the freshly generated `codex-app/content/webview/assets/`, copy only minimal synthetic strings into test functions: the route table entry for `/pull-requests`, the `sidebarElectron.pullRequestsRouteNavLink` nav block, the Pull Requests lazy-route declaration, the shared React/Markdown/external-link imports, and their enclosing expressions. Do not copy full minified bundles or generated assets into the feature.

- [ ] **Step 2: Write failing route/nav attachment tests**

Assert the patch adds exactly one `/issues`, one `sidebarElectron.issuesRouteNavLink` fallback text `Issues`, one native dynamic import of `/github-issues-tab.mjs`, and one dependency object passed to `createIssuesRoute`. Reapply and assert byte-for-byte equality. Remove each anchor and assert `{matched:false,changed:0}` plus unchanged source.

- [ ] **Step 3: Implement semantic asset discovery**

Walk only `webview/assets/*.js`. Resolve:

- the unique route asset containing `/pull-requests` and `PullRequestsRoute`;
- the unique nav asset containing `sidebarElectron.pullRequestsRouteNavLink`; and
- the Pull Requests detail/shared dependency asset containing its Markdown and external-link call sites.

Reject zero or multiple candidates. `patchIssuesRouteAssets` collects the route and dependency changes in memory before writing either file, so dependency discovery cannot leave a half-attached route.

- [ ] **Step 4: Add the Issues lazy route and dependency handoff**

Insert a lazy route component that performs:

```js
React.lazy(()=>import(`/github-issues-tab.mjs`).then(m=>({default:m.createIssuesRoute({React,components,Markdown,openExternal})})))
```

Use the captured current-bundle identifiers, not new globals. Add the `/issues` route beside `/pull-requests`, preserving the app's existing error boundary and suspense wrapper.

- [ ] **Step 5: Add the navigation item**

Clone only the structural Pull Requests nav expression, replace its route/id/icon/label with `/issues`, `IssuesRoute`, an existing issue/circle-dot icon from current shared assets, and an i18n call with default message `Issues`. Do not duplicate PR data hooks or actions.

- [ ] **Step 6: Write files only after the full transaction validates**

`patchIssuesRouteAssets(extractedDir)` returns `{matched:true,changed:N}` after writing all route/dependency assets, `{matched:true,changed:0}` when markers show it is already applied, or `{matched:false,changed:0,reason}` without writing on drift. Register it as `github-issues-renderer-route`, `extracted-app:post-webview`, after the preload patch, with `ciPolicy:"optional"`.

`patchIssuesNavigationAssets(extractedDir)` first verifies the route marker exists somewhere under `webview/assets`, then patches only the nav asset. Register it as the later `github-issues-navigation` descriptor. If the route descriptor skipped, navigation also skips, preventing a dead sidebar link. Together with `github-issues-preload-bridge` and `github-issues-main-bridge`, the feature reports four independent patch entries.

- [ ] **Step 7: Run route attachment and all local tests**

Run:

```bash
node --test linux-features/local/github-issues-tab/test.js
node --test linux-features/local/github-issues-tab/issues-adapter.test.js
```

Expected: all tests PASS, including idempotence and deliberate drift fixtures.

- [ ] **Step 8: Commit route and navigation attachment**

Run:

```bash
git add -f linux-features/local/github-issues-tab/patch.js linux-features/local/github-issues-tab/test.js
git commit -m "feat: attach local GitHub Issues route"
```

Expected: commit succeeds with only Task 6 files.

---

### Task 7: Stage, rebuild, and verify the current DMG integration

**Files:**
- Modify: `linux-features/features.json`
- Create: `linux-features/local/github-issues-tab/VALIDATION.md`
- Verify generated: `codex-app/`, `dist-next/rebuild/patch-report.json`

**Interfaces:**
- Consumes: the complete local feature from Tasks 1–6.
- Produces: a locally rebuilt app with the feature enabled and an evidence-backed patch report.

- [ ] **Step 1: Enable only the local feature**

Set the ignored local config to:

```json
{
  "enabled": ["github-issues-tab"]
}
```

- [ ] **Step 2: Run all focused and relevant regression tests**

Run:

```bash
node --test linux-features/local/github-issues-tab/test.js
node --test linux-features/local/github-issues-tab/issues-adapter.test.js
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
bash tests/scripts_smoke.sh
```

Expected: every command exits 0; report exact pass/fail counts rather than inferring from earlier runs.

- [ ] **Step 3: Rebuild from the current local DMG**

Run: `./install.sh ./Codex.dmg`

Expected: exit 0, the staged manifest lists `github-issues-tab`, and all four feature patch entries report `applied` or `already-applied` rather than `skipped-optional`.

- [ ] **Step 4: Verify staged ownership and syntax**

Run:

```bash
node --check codex-app/.codex-linux/features/github-issues-tab/issues-adapter.js
node --check codex-app/.codex-linux/features/github-issues-tab/protocol.js
node --check codex-app/content/webview/github-issues-tab.mjs
rg -n 'github-issues-tab|github-issues' codex-app/.codex-linux/linux-features-staged.json dist-next/rebuild/patch-report.json
```

Expected: syntax checks exit 0; staged paths are owned by `github-issues-tab`; route, preload, and main bridge patches are present in the report.

- [ ] **Step 5: Run a real read-only adapter smoke test**

Run this bounded smoke script; it stores only normalized adapter output in a private temporary directory and removes it afterward:

```bash
set -e
smoke_dir="$(mktemp -d)"
chmod 700 "$smoke_dir"
adapter_node="codex-app/resources/node-runtime/bin/node"
adapter_path="codex-app/.codex-linux/features/github-issues-tab/issues-adapter.js"
printf '%s\n' '{"version":1,"requestId":"smoke-capabilities","operation":"capabilities","input":{"host":null}}' \
  | "$adapter_node" "$adapter_path" > "$smoke_dir/capabilities.json"
jq -e '.ok == true and (.data.host | type == "string") and (.data.viewerLogin | type == "string") and (has("token") | not) and (.data | has("token") | not)' "$smoke_dir/capabilities.json"
smoke_host="$(jq -r '.data.host' "$smoke_dir/capabilities.json")"
jq -nc --arg host "$smoke_host" '{version:1,requestId:"smoke-list",operation:"listIssues",input:{host:$host,view:"assigned",state:"open",repository:null,text:"",cursor:null}}' \
  | "$adapter_node" "$adapter_path" > "$smoke_dir/list.json"
jq -e '.ok == true and (.data.issues | type == "array") and ([.. | objects | has("token")] | any | not)' "$smoke_dir/list.json"
rm -r -- "$smoke_dir"
```

Expected: both `jq -e` checks exit 0. Do not print raw private bodies or comments.

- [ ] **Step 6: Launch and perform the live UI acceptance pass**

Run: `./codex-app/start.sh`

Verify manually:

1. Issues appears once beside Pull Requests and opens `/issues`.
2. Assigned, Authored, and All load for the displayed host.
3. State/repository/text filters, refresh, selection, and pagination work.
4. Detail renders safe Markdown, comments, supported events, and generic events.
5. Keyboard focus/scroll/panel sizing matches Pull Requests.
6. External links open correctly.
7. No mutation or task-start action appears.
8. Offline/auth/rate-limit/partial failures are distinct where reproducible.

- [ ] **Step 7: Verify disabling restores the base app**

Temporarily set `linux-features/features.json` to `{"enabled":[]}`, stage into a temporary app directory through the feature staging helper, and assert the three staged resources are removed and no `github-issues-tab` manifest entries remain. Restore the enabled local config for continued use; do not alter `features.example.json`.

- [ ] **Step 8: Run cleanup and final repository verification**

Run:

```bash
bash /home/tnnrpolley21/.codex/hooks/codex-cleanup.sh --repo-root .
git status --short --branch
git status --short --ignored linux-features/local/github-issues-tab linux-features/features.json
```

Expected: cleanup reports `cleanup_state: clean`; tracked status is clean; only `linux-features/features.json` remains ignored local state.

- [ ] **Step 9: Record and commit current-DMG validation evidence**

Create `VALIDATION.md` with the tested DMG/app version, date, exact commands and exit statuses, patch-report statuses, authenticated hostname category (`github.com` or Enterprise hostname without account secrets), and the eight manual acceptance outcomes. Do not include tokens, raw private Issue data, logs, generated artifacts, or screenshots containing private content.

Run:

```bash
git add -f linux-features/local/github-issues-tab/VALIDATION.md
git commit -m "test: validate local GitHub Issues tab"
```

Expected: commit succeeds and `git status --short --branch` is clean.

## Execution notes

- Red/green evidence is required for each TDD task. Do not accept a test that was first observed only after the implementation existed.
- The implementation is intentionally force-tracked only on this local feature branch so subagent task reviews can use commit diffs. Do not push or publish it without separate authorization.
- If current-DMG inspection disproves a route/preload/main seam assumed here, stop at that task, update the approved design/plan with the discovered boundary, and obtain review before broadening core scope.
- Do not modify generated `codex-app/start.sh`, installed `/opt/codex-desktop`, or user cache assets to make the prototype appear to work.
