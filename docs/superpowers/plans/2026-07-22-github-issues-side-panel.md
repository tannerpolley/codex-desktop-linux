# GitHub Issues Environment Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the local GitHub Issues entry from the top-left navigation into the Pinned Summary Environment section and open the read-only Issues view in a native right side-panel tab.

**Architecture:** Keep the existing adapter, IPC bridge, reducer, list/detail UI, and timeline. Extend the renderer with a compact side-panel mode, remove the Issues nav injection, patch the current DMG summary callback chain beside the existing Pull Request callback, and register one stable Issues side-panel tab using the same tab store API as Pull Requests.

**Tech Stack:** Node.js feature patch descriptors, current-DMG minified JavaScript asset patching, React renderer module, Node test runner, isolated Codex Electron candidate.

## Global Constraints

- Do not change the GitHub Issues adapter or its read-only GraphQL operations.
- Do not navigate, reload, overwrite, or stop the currently open `/opt/codex-desktop` Codex window.
- Keep patches fail-soft and idempotent; drift must skip the optional descriptor without writing partial output.
- Keep the feature local and disabled by default; do not change `features.example.json`.
- Verify behavior from an isolated worktree/candidate app and run the repository cleanup audit.

### Task 1: Define failing contracts for side-panel rendering and asset patching

**Files:**
- Modify: `linux-features/local/github-issues-tab/test.js`
- Modify: `linux-features/local/github-issues-tab/renderer.mjs`
- Modify: `linux-features/local/github-issues-tab/patch.js`

**Interfaces:**
- `createIssuesSidePanel(deps)` will return a React component with the same bridge behavior as `createIssuesRoute`, configured for compact layout.
- `patchIssuesSummaryAssets(extractedDir)` will patch the Environment summary/callback chain and return `{matched, changed, reason?}`.
- `patchIssuesSidePanelAssets(extractedDir)` will add the opener/tab wrapper and return `{matched, changed, reason?}`.

- [ ] **Step 1: Add failing renderer contract tests**

  Add assertions beside the existing renderer source tests:

  ```js
  test("renderer exposes a compact Issues side-panel component", async () => {
    const module = await renderer();
    assert.equal(typeof module.createIssuesSidePanel, "function");
    const source = fs.readFileSync(path.join(featureDir, "renderer.mjs"), "utf8");
    assert.match(source, /createIssuesSidePanel/);
    assert.match(source, /compact/);
  });
  ```

- [ ] **Step 2: Add failing patch fixture contracts**

  Extend the synthetic asset fixture with a summary asset containing the current
  `Lv`/`zb`/`Bb`/`Hv`/`Uv` callback chain and a local-conversation asset containing
  the `cl` Pull Request opener and `du`/`fu` call sites. Assert that the new
  descriptors exist, the old navigation descriptor does not, and the first
  patch inserts `onOpenIssuesSidePanel`, an Environment Issues action, a stable
  `issues` tab id, and `createIssuesSidePanel`.

- [ ] **Step 3: Run the focused tests and verify RED**

  Run:

  ```bash
  node --test linux-features/local/github-issues-tab/test.js
  ```

  Expected: failure because `createIssuesSidePanel` and the new patch functions
  are not yet present.

### Task 2: Implement the reusable compact Issues renderer

**Files:**
- Modify: `linux-features/local/github-issues-tab/renderer.mjs:439-441,579-775`
- Test: `linux-features/local/github-issues-tab/test.js`

**Interfaces:**
- `createIssuesRoute(deps)` accepts `deps.compact === true` and applies a
  compact class/style contract without changing reducer or bridge behavior.
- `createIssuesSidePanel(deps)` delegates to `createIssuesRoute({...deps, compact:true})`.

- [ ] **Step 1: Add the minimal compact renderer implementation**

  Add `compact` to the dependency boundary, add a `github-issues-route-compact`
  class when enabled, and make the stylesheet switch to a stacked inbox/detail
  layout at the side-panel width. Export:

  ```js
  export function createIssuesSidePanel(deps = {}) {
    return createIssuesRoute({ ...deps, compact: true });
  }
  ```

- [ ] **Step 2: Run renderer tests and verify GREEN**

  Run:

  ```bash
  node --test linux-features/local/github-issues-tab/test.js
  ```

  Expected: renderer contract tests pass; patch fixture tests remain failing.

### Task 3: Patch summary callbacks, Environment action, and side-panel opener

**Files:**
- Modify: `linux-features/local/github-issues-tab/patch.js:264-380`
- Modify: `linux-features/local/github-issues-tab/test.js:220-330`
- Test: `linux-features/local/github-issues-tab/test.js`

**Interfaces:**
- `patchIssuesSummaryAssets` locates the current summary asset and transactionally
  adds the Issues callback through `Lb`, `zb`, `Bb`, `Hv`, `Uv`/`Wv`, and `Lv`.
- `patchIssuesSidePanelAssets` locates the current local-conversation asset,
  defines a lazy Issues side-panel component and `codexLinuxGithubOpenIssuesSidePanel`,
  and adds callbacks to the `du`, `fu`, and `bo` call sites.
- Existing `patchIssuesRouteAssets` continues to register `/issues` but does not
  add a top-left nav item.

- [ ] **Step 1: Implement route-only behavior and remove nav injection**

  Delete the navigation descriptor from `descriptors`, retain the route marker,
  and export no write-capable navigation patch. Update tests to assert the
  descriptor count and that the fixture contains no `sidebarElectron.issuesRouteNavLink`.

- [ ] **Step 2: Implement the summary patch with exact current-DMG anchors**

  Locate the asset containing `sectionKey:\`environment\`` and the `Lv` callback
  chain. Add the new prop to each destructuring/call-site in the chain and insert
  one `J.ItemButton` in the Environment section with label `Issues` and
  `onClick:()=>{onOpenIssuesSidePanel?.()}`. Return unchanged output on missing
  or ambiguous anchors.

- [ ] **Step 3: Implement the side-panel opener patch**

  In the local-conversation asset, add a lazy component that imports
  `/github-issues-tab.mjs` and calls `createIssuesSidePanel({React,components:{},openExternal})`.
  Add a stable tab opener modeled on `cl`:

  ```js
  const id = "issues";
  const side = Li(scope, id) ?? "right";
  Bi(side).openTab(scope, issuesPanel, { activate: true, id, props: {}, title: "Issues" });
  Hi(scope, side);
  ```

  Pass the callback from `du` through `bo` and `fu` so both inline and pinned
  summary presentations can invoke it.

- [ ] **Step 4: Run the focused patch tests and verify GREEN**

  Run:

  ```bash
  node --test linux-features/local/github-issues-tab/test.js
  ```

  Expected: all feature tests pass, including idempotency and deliberate drift
  preservation tests.

### Task 4: Isolated build and runtime verification

**Files:**
- Modify: none beyond Tasks 1–3
- Test: generated candidate app in a separate worktree/output directory

- [ ] **Step 1: Run all focused regression tests**

  ```bash
  node --test linux-features/local/github-issues-tab/test.js
  node --test linux-features/local/github-issues-tab/issues-adapter.test.js
  node --test scripts/patch-linux-window-ui.test.js
  ```

- [ ] **Step 2: Build an isolated candidate**

  Create a temporary sibling worktree at `/tmp` or a sibling clone, enable only
  `github-issues-tab`, and build into that candidate. Do not overwrite
  `codex-app/` used by the open Codex window.

- [ ] **Step 3: Verify the real UI in the isolated app**

  Launch only the candidate app on its own port/state. Confirm that the top-left
  Issues item is absent, the Pinned Summary Environment section contains an
  Issues action, clicking it opens a single `Issues` right side-panel tab, and
  the existing issue rows still load. Close only the candidate process.

- [ ] **Step 4: Run cleanup and inspect Git state**

  ```bash
  bash "$HOME/.codex/hooks/codex-cleanup.sh" --repo-root .
  git status --short --branch
  git diff --check
  ```

  Preserve unrelated `.serena/` metadata and report it separately if it remains
  untracked.

