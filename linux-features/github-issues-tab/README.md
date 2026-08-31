# GitHub Issues

This optional feature adds **Issues** directly below the upstream **Pull requests** sidebar item. It follows the same account-wide inbox shape: search, relationship/state/repository filters, an issue list, and a persistent detail pane.

The feature uses the existing `gh` login on the selected GitHub host. It is read-only and never exposes credentials to the renderer. Committed configuration keeps it disabled by default.

Enable it in ignored local configuration:

```json
{
  "enabled": ["github-issues-tab"]
}
```

Focused checks:

```bash
node --test linux-features/github-issues-tab/test.js
xvfb-run -a npm run test:issues-ui
```

The headless check loads the renderer through the same lazy-component contract as the upstream Pull Requests route. Runtime acceptance must also patch the current signed package, load `/issues` in an isolated Electron profile, and assert that the account-wide list and detail pane render without module, console, or bridge errors. A live-account query is release evidence, not a CI dependency.
