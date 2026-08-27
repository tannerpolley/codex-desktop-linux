# Personal fork workflow

Keep `main` suitable for synchronizing with the upstream project. Run the
personally installed application from `codex/personal-linux`, which is the
integration branch for accepted customizations.

Each independent customization should have:

- one focused commit containing its implementation, tests, and documentation;
- a `codex/<topic>` branch rooted at the upstream-ready base when the change is
  useful independently;
- a merge or cherry-pick into `codex/personal-linux` after validation.

This separates three concerns:

1. Fetch upstream changes without mixing them into personal work.
2. Refresh or remove one customization without rewriting unrelated features.
3. Build the installed package from one reproducible integration branch.

Suggested synchronization sequence:

```bash
git fetch origin
git switch main
git merge --ff-only origin/main
git switch codex/personal-linux
git merge main
```

Resolve and validate each topic branch before merging it into the integration
branch. Push topic branches only while they are active or useful for review;
do not create a permanent remote branch for every tiny follow-up fix. Keep
those fixes in the owning topic's commit history instead.
