# GitHub Issues Tab

This tracked, optional feature adds a read-only GitHub Issues
inbox and timeline opened from an Issues button in the Pinned Summary
Environment section. The button opens the compact Issues view in the app's
side panel. It targets the current signed official Linux `.deb` payload and is
disabled by default.

The feature requires GitHub CLI 2.81.0+ (`gh`) authentication for the selected
GitHub.com or Enterprise host. Older or malformed CLI versions return an
upgrade-required result before authentication discovery. It never accepts
GraphQL from the renderer, does not expose credentials, and does not create,
edit, close, or otherwise mutate GitHub Issues.

To enable the feature for a rebuild, write the following to the ignored
`linux-features/features.json` file:

```json
{
  "enabled": ["github-issues-tab"]
}
```

Run the focused contract tests with:

```bash
node --test linux-features/github-issues-tab/test.js
```

Run the adapter contract tests too:

```bash
node --test linux-features/github-issues-tab/issues-adapter.test.js
```

The `preview/` fixtures reuse the production renderer with local data for
browser-only UI work; they never call GitHub or require authentication.

When the feature is enabled, Settings → Linux desktop exposes a **GitHub
Issues** toggle. It defaults on and is persisted as
`codex-linux-github-issues-enabled`; turn it off to stop the Issues view from
making requests while leaving the rest of the app usable. An already-open
Issues panel shows that it is disabled until the setting is turned back on.

To disable the feature, remove `github-issues-tab` from the ignored
`linux-features/features.json` list (or set `{"enabled":[]}`), then rebuild
the app with `./install.sh` or the repository's candidate rebuild command.
