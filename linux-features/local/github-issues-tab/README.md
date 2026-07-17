# GitHub Issues Tab (local prototype)

This is a current-DMG-only prototype for a local, read-only GitHub Issues
inbox and timeline beside Pull Requests. The feature is local/ignored by
default and is not enabled in the committed feature configuration.

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

When later implementation files are present, run their focused tests too:

```bash
node --test linux-features/local/github-issues-tab/issues-adapter.test.js
```

To disable the prototype, remove `github-issues-tab` from the ignored
`linux-features/features.json` list (or set `{"enabled":[]}`), then rebuild
the app with `./install.sh` or the repository's candidate rebuild command.
