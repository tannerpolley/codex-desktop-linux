# GitHub Issues Tab (local prototype)

This is a current-DMG-only prototype for a local, read-only GitHub Issues
inbox and timeline opened from an Issues button in the Pinned Summary
Environment section. The button opens the compact Issues view in the app's
side panel. The feature is local/ignored by default and is not enabled in the
committed feature configuration.

The feature requires GitHub CLI 2.81.0+ (`gh`) authentication for the selected
GitHub.com or Enterprise host. Older or malformed CLI versions return an
upgrade-required result before authentication discovery. It never accepts
GraphQL from the renderer, does not expose credentials, and does not create,
edit, close, or otherwise mutate GitHub Issues.

To enable this local feature for a rebuild, write the following to the ignored
`linux-features/features.json` file:

```json
{
  "enabled": ["github-issues-tab"]
}
```

Run the focused contract tests with:

```bash
node --test linux-features/local/github-issues-tab/test.js
```

Run the adapter contract tests too:

```bash
node --test linux-features/local/github-issues-tab/issues-adapter.test.js
```

For UI work without launching Electron, serve the browser-only fixture preview:

```bash
make issues-preview
```

Open `http://127.0.0.1:4173/preview/` in the in-app browser. It reuses the
production Issues renderer with four local issues and mock capabilities, detail,
and timeline responses; it never calls GitHub or requires authentication. The
preview fixture is pinned to `cli/cli`; the installed feature instead uses the
GitHub repository resolved from the workspace origin remote.

When the feature is enabled, Settings → Linux desktop exposes a **GitHub
Issues** toggle. It defaults on and is persisted as
`codex-linux-github-issues-enabled`; turn it off to stop the Issues view from
making requests while leaving the rest of the app usable. An already-open
Issues panel shows that it is disabled until the setting is turned back on.

To disable the prototype, remove `github-issues-tab` from the ignored
`linux-features/features.json` list (or set `{"enabled":[]}`), then rebuild
the app with `./install.sh` or the repository's candidate rebuild command.
