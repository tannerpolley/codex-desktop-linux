# GitHub Issues tab validation

The feature-enabled build record below was validated against upstream ChatGPT Desktop `26.707.62119` / Electron `42.1.0`
from `Codex.dmg` SHA-256
`c243c94f8de6a51f5530ffe1f8d0c1588733d890ac692e34aaca06d95ba637ca`.
It is retained as feature-enabled provenance; the current source checks are
listed separately because the committed feature configuration remains disabled.

## Current source checks

- `node --test linux-features/local/github-issues-tab/test.js linux-features/local/github-issues-tab/issues-adapter.test.js`: 90 passed.
- `node --test scripts/patch-linux-window-ui.test.js`: 413 passed.
- `node --test linux-features/local/github-issues-tab/test.js linux-features/local/github-issues-tab/issues-adapter.test.js linux-features/*/test.js`: 940 passed, 1 skipped. The real app-server integration is opt-in with `CODEX_RUN_APP_SERVER_INTEGRATION=1`.
- `node --test tests/github_issues_preview.test.js`: 1 passed.
- `bash tests/dev-install_smoke.sh`: passed.
- `bash tests/scripts_smoke.sh`: passed, including native-package, AppImage, feature staging, and transactional promotion coverage.
- `./install.sh ./Codex.dmg`: `accepted_with_warnings`; all 17 required core entries passed and all four `github-issues-tab` descriptors applied. The only warning was the pre-existing optional `linux-browser-use-webview-attach-recovery` drift.
- A fresh post-review extraction of the same DMG confirmed the hardened native-tray gate applies, is idempotent, and verifies upstream teardown plus icon fallback before bypassing obsolete tray compatibility code.

The accepted rebuild report is under
`dist-next/rebuild/transactions/20260717T223539-2472020-10016/`.

## Live app checks

- Launched the accepted app as an isolated instance and opened `/issues` through the app's own Electron renderer.
- Confirmed the preload bridge is present and the live main-process round trip returns the expected sanitized `gh-upgrade-required` response on this host.
- Confirmed the route leaves the startup loader, renders the Issues sidebar item, Assigned/Authored/All and Open/Closed/All filters, repository/text filters, inbox/detail regions, and the GitHub CLI upgrade state.
- Inspected the route at 1920×1040 and 900×800. At 720 px, computed layout switches the inbox/detail region to the responsive column layout.

The installed GitHub CLI is `2.45.0`, below the feature's required `2.81.0`, so live private Issue data was deliberately not fetched. Adapter tests cover the authenticated GitHub.com and GitHub Enterprise success paths without exposing account data.
