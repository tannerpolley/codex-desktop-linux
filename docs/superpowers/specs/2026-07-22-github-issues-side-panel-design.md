# GitHub Issues Environment Side Panel

## Goal

Replace the local GitHub Issues top-left navigation item with an Issues action in
the Pinned Summary mini window's Environment section. Activating that action
opens the existing read-only Issues inbox and timeline in the native right side
panel, without changing the GitHub adapter or touching an already-running Codex
window.

## Design

The existing Issues route remains the single renderer implementation for list,
filters, detail, and timeline state. The route is loaded as a reusable side
panel tab rather than exposed through the top-left navigation. A compact mode
is added at the renderer boundary so the side panel uses a stacked list/detail
layout at its narrower width.

The feature patch adds one Environment-section action beside the existing local
Git actions and Pull Request row. The action receives a callback through the
same summary-panel plumbing already used by Pull Requests. The callback opens a
stable `issues` side-panel tab with the feature renderer, activating the tab if
it already exists instead of creating duplicates.

The patch remains fail-soft and current-DMG anchored. If the Environment or
side-panel anchors drift, the feature reports an optional skipped descriptor and
does not create a dead control. The old Issues navigation descriptor is removed
from the feature's patch registration and its tests assert that no top-left
Issues nav marker is emitted.

## Validation

- Unit tests cover the renderer compact-mode contract, Environment injection,
  callback plumbing, side-panel registration, idempotency, and drift skips.
- Existing adapter, renderer, and patch tests continue to pass.
- An isolated candidate app is built from a separate worktree/candidate output.
  Runtime verification checks that the Environment Issues action is visible and
  opens the Issues tab in the side panel. The currently open Codex app is not
  navigated, reloaded, or stopped.
