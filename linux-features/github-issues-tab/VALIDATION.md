# GitHub Issues tab validation

The retained pre-migration implementation and its 26.820 port attempt are
preserved in Git history and the named migration stash. This tracked feature
now targets the current signed official Linux `.deb` source pipeline.

## Source checks

Run the feature contracts with:

```bash
node --test \
  linux-features/github-issues-tab/test.js \
  linux-features/github-issues-tab/issues-adapter.test.js
```

Run the shared feature and patch framework checks with:

```bash
node --test \
  scripts/lib/linux-features.test.js \
  scripts/patch-linux-window-ui.test.js \
  linux-features/*/test.js
```

## Official package check

Use `./install.sh --inspect /path/to/chatgpt_<version>_<arch>.deb` with
only `github-issues-tab` enabled in the ignored `linux-features/features.json`.
All five feature descriptors must apply cleanly. Disabled features are not
probed, and the official package is never replaced by this inspection route.

## Current migration result

Validated on 2026-08-26 against signed APT metadata for
`chatgpt_26.820.60940_amd64.deb` (SHA-256
`31d956a8c6c515f8d87e0b7acd9ec919f7e685ba59331b4b97aa45f853afdfd7`):

- GitHub Issues feature and adapter contracts: 91 passed.
- `ui-tweaks` contracts, including skill mention ordering: 70 passed.
- Linux feature framework: 31 passed.
- Official baseline patch registry: 4 passed.
- Empty-feature package inspection preserved `app.asar` byte-for-byte.
- Custom inspection applied all five GitHub Issues descriptors and the one
  skill mention ordering descriptor; no enabled requested descriptor drifted.
