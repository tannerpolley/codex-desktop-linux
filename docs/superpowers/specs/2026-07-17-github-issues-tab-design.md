# GitHub Issues Tab Local Prototype Design

**Date:** 2026-07-17

**Status:** Approved design; pending implementation plan

**Delivery:** Branch-local Linux feature prototype

## Summary

Add a read-only **Issues** tab beside the existing **Pull Requests** tab. The
new route should feel like a sibling of the Pull Requests inbox: it provides
Assigned, Authored, and All views, list filtering and pagination, and a
persistent detail pane. Selecting an Issue renders its body, comments, and
meaningful timeline events without offering mutation or task-start actions.

The implementation belongs under
`linux-features/local/github-issues-tab/`. That directory is normally
gitignored, but this prototype is intentionally force-tracked on its local
feature branch so task commits and reviews have durable diffs. It must not be
pushed or proposed upstream without separate authorization. The feature
remains disabled unless it is explicitly enabled in the local
`linux-features/features.json`; tracking it does not make it a supported
repository feature.

## Goals

- Put an **Issues** navigation item beside **Pull Requests** and register an
  `/issues` route.
- Match the existing Pull Requests tab's interaction model, visual language,
  keyboard behavior, and detail-panel layout.
- Support GitHub.com and GitHub Enterprise accounts authenticated through the
  GitHub CLI.
- Provide Assigned, Authored, and All inbox views with open/closed state,
  repository, and text filters.
- Render a complete, readable Issue detail timeline.
- Keep GitHub credentials out of renderer JavaScript and browser storage.
- Fail softly when an upstream DMG changes the renderer, preload, or main
  bundle seams targeted by this local prototype.

## Non-goals

- Creating, editing, closing, reopening, labeling, assigning, or commenting on
  Issues.
- Starting a Codex task from an Issue.
- Notifications, subscriptions, saved searches, or background polling.
- Shipping, pushing, or enabling a supported repository feature.
- Preserving compatibility with older DMG asset shapes.
- Reimplementing the Pull Requests route wholesale when stable shared UI
  pieces can be reused.

## Chosen approach

Use a hybrid design:

1. Patch the current renderer to add the navigation item, route, and a small
   Issues UI chunk that selectively reuses stable Pull Requests/shared UI
   components and design tokens.
2. Patch the existing Electron preload bridge with a single namespaced,
   read-only Issues request method.
3. Patch the main process with a matching validated handler.
4. Have the main process invoke a staged adapter through the packaged managed
   Node.js runtime. The adapter runs fixed `gh api graphql` operations and
   returns normalized JSON over stdio.

This uses the app's existing renderer-to-main trust boundary. It avoids a
listening loopback port, CORS policy, bearer-secret exchange, and orphaned
server discovery. The renderer cannot submit arbitrary shell commands or
GraphQL documents.

Directly adapting the Pull Requests transport was rejected because its query
model is Pull Request-specific and its minified internals are likely to drift.
Driving GitHub connector tools was rejected because those tools are designed
for task activity and do not provide a reliable standalone route or full Issue
timeline contract.

## Feature contents

The local feature is expected to contain:

- `README.md`: enablement, current-DMG pin, limitations, and validation notes.
- `feature.json`: patch descriptors plus staged adapter/UI resources.
- `patch.js`: idempotent renderer, preload, and main-process descriptors.
- `issues-adapter.js`: fixed GitHub CLI/GraphQL operations and normalization.
- A renderer module or staged asset for the route UI.
- Tests and JSON fixtures for patches, queries, normalization, and UI states.

The exact filenames may be refined during implementation planning, but the
responsibilities remain separated: bundle patching, privileged data access,
normalization, and rendering must not collapse into one large injected source
string.

## Architecture and data flow

```text
Issues route
  -> window.electronBridge.githubIssues.request(operation, input)
  -> dedicated preload IPC channel
  -> main-process schema and operation validation
  -> staged issues-adapter.js via managed Node.js
  -> gh api graphql --hostname <authenticated-host>
  -> normalized JSON over stdout
  -> main process
  -> Issues route state and rendering
```

The bridge exposes only these conceptual operations:

- `capabilities`: report adapter availability, authenticated hosts, active
  host, authenticated viewer login, and feature version.
- `listIssues`: return one page for a selected view and filters.
- `getIssue`: return metadata, body, and the first timeline page.
- `getIssueTimelinePage`: continue a selected Issue's timeline.
- `cancel`: stop work associated with a request identifier when practical.

Operation names, field types, lengths, enum values, and hostnames are validated
in both the main handler and adapter. The adapter owns the GraphQL documents;
the renderer never supplies one.

One adapter invocation handles one request. This keeps the process lifecycle
simple and allows the main process to terminate work that belongs to a stale
selection. The adapter must terminate its `gh` child on cancellation or parent
exit and emit exactly one JSON response. Diagnostics go to stderr and must not
contain credentials or full private response payloads.

## GitHub host and authentication behavior

The feature uses GitHub CLI authentication only. It does not read or persist a
token itself.

- If the existing Pull Requests account state exposes a selected hostname, the
  route passes that hostname to the bridge.
- Otherwise, `capabilities` resolves the active authenticated `gh` host.
- A requested hostname is accepted only when it matches an authenticated CLI
  host returned by the adapter.
- The active hostname is visible in the inbox so an Enterprise response cannot
  be mistaken for GitHub.com data.
- Account or host changes invalidate inbox/detail state and trigger a fresh
  capabilities request.

## Inbox query semantics

The adapter resolves the authenticated viewer login for the selected host.
All searches include `is:issue`, exclude Pull Requests, and sort by most
recently updated first.

- **Assigned:** Issues matching `assignee:<viewer-login>`.
- **Authored:** Issues matching `author:<viewer-login>`.
- **All:** Issues matching `involves:<viewer-login>`. This is an
  account-relevant inbox, not an unbounded search across every public Issue on
  the host.

The state filter contributes `is:open`, `is:closed`, or neither. The repository
filter contributes one validated `repo:owner/name` qualifier. Free text is sent
as a GraphQL variable and incorporated by the adapter's query builder; the
renderer cannot append arbitrary GraphQL syntax.

The adapter returns a stable summary model containing:

- node identifier, hostname, repository owner/name, number, and URL;
- title, state, state reason when available, author, created time, and updated
  time;
- labels, assignees, milestone summary, comment count, and viewer relationship;
- pagination cursor and GitHub rate-limit metadata.

Duplicate nodes are removed by node identifier. Results from an older request
identifier must never overwrite newer filter, page, host, or selection state.

## Inbox experience

The new route mirrors the Pull Requests inbox rather than introducing a new
shell:

- Assigned, Authored, and All segmented views.
- Open, Closed, and All state filtering.
- Repository and text filters.
- Refresh, forward pagination, loading, empty, partial, and error states.
- A row showing repository, Issue number, title, state, labels, author,
  assignees, comment count, and last update time.
- A persistent detail pane that updates when a row is selected.

Focus treatment, keyboard selection, scrolling, spacing, typography, colors,
dividers, and panel sizing follow the Pull Requests route. Shared components or
tokens may be reused only when their exports and behavior are stable enough for
the current DMG fixture. The feature should own a small adapter component when
direct reuse would couple it to unrelated Pull Request behavior.

No button or menu may create a task or mutate the Issue. Links to the Issue,
repository, user, commit, or Pull Request open through the app's existing safe
external-link behavior.

## Issue detail and timeline

The detail header renders:

- title, repository and Issue number, state, state reason, and URL;
- author, creation time, and update time;
- labels, assignees, milestone, and linked project information when returned by
  the host.

The Issue body uses the same safe Markdown and rich-content conventions as the
Pull Requests detail UI. The chronological timeline then renders:

- Issue comments;
- label and unlabel events;
- assignment and unassignment events;
- milestone and unmilestone events;
- close and reopen events;
- title changes;
- references and cross-references;
- transfers; and
- a compact generic representation for an unknown event type.

The adapter normalizes GitHub's timeline union into a discriminated local
model. Missing actors, deleted users, unavailable private cross-references, and
missing optional fields must degrade without dropping the rest of the timeline.
Timeline pages append in chronological order and deduplicate by event or node
identifier.

## State, caching, and cancellation

Route state is partitioned by hostname, inbox view, state filter, repository
filter, and text filter. Detail state is partitioned by hostname and Issue node
identifier.

- Cache only in memory for the current app process.
- Preserve a selected Issue while refreshing its current list when it remains
  present.
- Abort or ignore list requests superseded by new filters.
- Abort or ignore detail requests superseded by a new selection.
- Do not background-poll. Refresh occurs on explicit user action or view/host
  changes.
- Surface rate-limit cost and reset time when available rather than retrying in
  a loop.

## Failure behavior

The UI distinguishes:

- GitHub CLI missing;
- no authenticated account;
- requested host not authenticated;
- adapter or managed Node.js runtime unavailable;
- network/offline failure;
- authorization failure;
- rate limit exhausted;
- partial GraphQL data with usable Issues;
- malformed adapter response; and
- renderer, preload, or main bundle patch drift.

Partial GraphQL responses render usable data with a warning. Retry remains a
user action. An adapter or query failure affects only the Issues route. Patch
descriptors are fail-soft and idempotent: drift is recorded in the patch report
and must not prevent Codex from launching.

## Security boundary

- No GitHub token crosses the Electron bridge or enters renderer storage.
- The bridge accepts fixed operations and validated JSON only.
- The main handler rejects unknown operations and overlong or malformed input
  before starting the adapter.
- The adapter owns all GraphQL documents and invokes `gh` without a shell.
- Hostnames must resolve to an authenticated CLI host.
- External content uses existing safe Markdown and external-link handling.
- Logs contain request identifiers, operation names, status, duration, and
  sanitized error categories only.
- Cancellation and app exit terminate task-owned adapter and `gh` processes.

## Patch strategy and upstream drift

The prototype targets only the current upstream DMG. Each descriptor should use
recognizable semantic anchors, verify its expected match count, insert an
explicit feature marker, and no-op when that marker already exists.

Separate descriptors cover:

1. route registration and navigation;
2. renderer bridge consumption and staged UI loading;
3. preload bridge exposure; and
4. main-process handler registration.

No descriptor should contain the whole feature implementation. Staged assets
hold substantial UI and adapter logic. If a current anchor is absent or
ambiguous, that descriptor reports a warning and leaves the target unchanged.
The app-launch path must remain usable even if none of the descriptors apply.

## Testing strategy

### Manifest and staging

- Validate the local manifest, resource targets, quoted file modes, README
  presence, and enabled/disabled staging behavior.
- Confirm disabling the feature removes its previously staged artifacts.

### Patch descriptors

- Apply each descriptor to a current-DMG fixture and verify exactly one nav
  item, route, bridge method, and handler.
- Apply a second time and verify byte-for-byte idempotence.
- Alter each semantic anchor and verify a warning plus unchanged output.
- Verify partial attachment cannot prevent the base app from launching.

### Adapter and bridge

- Mock process execution and cover capabilities, active host selection,
  hostname validation, Assigned/Authored/All query construction, state and
  repository filters, text input, pagination, and rate-limit metadata.
- Reject unknown operations, malformed input, excessive lengths, arbitrary
  GraphQL documents, and unauthenticated hostnames.
- Verify free text containing whitespace or shell metacharacters is passed as
  literal data without invoking a shell.
- Cover nonzero `gh` exits, invalid JSON, partial GraphQL errors, cancellation,
  parent exit, and credential-safe logging.

### Normalization

- Use fixtures for Issue body and comments; label, assignment, milestone,
  close/reopen, rename, reference, cross-reference, and transfer events;
  unknown events; deleted users; private references; and absent optional
  fields.
- Verify ordering, deduplication, and cursor continuation.

### Renderer states

- Cover loading, empty, populated, refreshing, partial, authorization, offline,
  rate-limit, and generic failures.
- Verify filter changes and selection changes suppress stale responses.
- Verify no mutation or task-start controls render.
- Verify keyboard, scroll, focus, and external-link behavior against the Pull
  Requests route conventions.

### Regression and live validation

- Run the local feature's explicit tests plus the relevant core patcher and
  Linux-feature suites.
- Enable only `github-issues-tab`, rebuild against the current DMG, and inspect
  the patch report.
- Launch the rebuilt app and verify the acceptance criteria below on the active
  GitHub host.
- Run the repository cleanup audit after task-owned build or test artifacts are
  created.

## Acceptance criteria

1. **Issues** appears once beside **Pull Requests** and opens `/issues`.
2. Assigned, Authored, and All return account-relevant Issues for the displayed
   authenticated hostname.
3. State, repository, and text filters plus pagination work without stale data
   replacing current state.
4. Selecting an Issue renders its metadata, safe Markdown body, comments, and
   supported timeline events in chronological order.
5. Unknown or partially unavailable timeline data degrades visibly without
   breaking the detail pane.
6. External links open through the existing desktop link behavior.
7. No Issue mutation or task-start control appears.
8. Missing auth, offline, rate-limit, partial-data, and adapter failures produce
   distinct useful states.
9. Disabling the feature restores the unmodified app behavior.
10. Patch drift is visible in reports and never prevents the rest of Codex from
    launching.

## Known tradeoffs

- The route, preload, and main-process patches are intentionally pinned to the
  current DMG and may need revision after an upstream release.
- Full timelines require more GraphQL cost and pagination than list-only Issue
  rendering; the UI therefore loads detail on selection and does not prefetch
  every timeline.
- GitHub Enterprise instances may omit newer timeline fields. The normalized
  model treats those fields as optional and surfaces partial-data warnings.
- The branch-local delivery gives the experimental integration reviewable
  commits without changing its disabled/private-feature status. Its tests will
  not run in normal repository CI unless explicitly invoked from the local
  feature path, and the branch must not be pushed without separate approval.

## Design completion

The architecture, inbox/detail experience, resilience boundary, and validation
criteria were reviewed and approved interactively. No unresolved product
decision blocks implementation planning.

## Validated external contracts

- GitHub documents the `author`, `assignee`, and `involves` Issue search
  qualifiers in its
  [Issue filtering and search reference](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests).
- The GitHub CLI documents GraphQL variables, cursor pagination, and explicit
  host selection for
  [`gh api`](https://cli.github.com/manual/gh_api).
- GitHub's GraphQL reference documents `Issue.timelineItems` as a paginated
  union whose available event types can evolve, supporting the normalized
  known-event plus generic-event design in the
  [Issues schema reference](https://docs.github.com/en/graphql/reference/issues).
