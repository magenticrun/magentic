# Plan 001: `bun run check` runs on every push and pull request

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f690ca..HEAD -- package.json README.md .github`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0f690ca`, 2026-09-02

## Why this matters

The repository has a complete one-command verification (`bun run check` runs typecheck, lint, and 71 tests in about ten seconds) but nothing runs it automatically: there is no `.github/` directory, no hook, and no pinned Bun version. Seventeen pull requests have merged without a gate. The most recent one (`5fe3eda`) shipped a shell tool that is imported but never registered (see plan 003); a green check would not have caught that particular bug, but every plan after this one adds tests that only matter if something runs them. The code also depends on Bun-only APIs (`Bun.YAML.parse`, `Bun.Glob`, `Bun.resolveSync`) with no declared version floor, so a contributor on an older Bun fails at config-load time with an unhelpful error.

## Current state

- `package.json` (root) — workspace manifest. Scripts, verbatim:

  ```json
  "scripts": {
    "prepare": "effect-tsgo patch --typescript",
    "dev": "bun run --filter @magentic/gateway dev",
    "test": "bun --bun vitest run",
    "test:watch": "bun --bun vitest",
    "typecheck": "tsc --noEmit && tsc --noEmit -p apps/cli/tsconfig.json",
    "lint": "oxlint && oxfmt --check",
    "format": "oxlint --fix; oxfmt",
    "check": "bun run typecheck && bun run lint && bun run test"
  },
  ```

  There is no `engines` field. `prepare` patches the installed TypeScript with the Effect language service; Bun runs the root package's `prepare` after `bun install`, and the command is idempotent ("typescript skipped because its hash matches the replacement").

- `bunfig.toml` — `[install] exact = false`, `saveTextLockfile = true`. The lockfile is `bun.lock` (text).
- `README.md:25-31` — the "Develop" section:

  ```sh
  bun install
  bun run dev          # gateway with reload on http://localhost:4321
  bun run check        # typecheck + lint + tests
  ```

- Local Bun version at planning time: `bun --version` → `1.4.0`.
- There is no `.github/` directory and no `.editorconfig`.
- Conventions: this repo uses Bun only (never npm/pnpm/yarn), per `CLAUDE.md`. The typecheck prints about 40 lines of `suggestion TS377…` diagnostics from the Effect language service and still exits 0; that is the current baseline, not a failure.

## Commands you will need

| Purpose    | Command                                                                                                   | Expected on success                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Install    | `bun install`                                                                                             | exit 0                                                                                         |
| Typecheck  | `bun run typecheck`                                                                                       | exit 0 (suggestion lines are fine)                                                             |
| Lint       | `bun run lint`                                                                                            | exit 0, "All matched files use the correct format."                                            |
| Tests      | `bun run test`                                                                                            | `Test Files  18 passed`, `Tests  71 passed` (counts may be higher if other plans landed first) |
| All        | `bun run check`                                                                                           | exit 0                                                                                         |
| YAML parse | `bun -e 'console.log(Object.keys(Bun.YAML.parse(await Bun.file(".github/workflows/check.yml").text())))'` | prints `[ "name", "on", "jobs" ]`                                                              |

## Scope

**In scope** (the only files you should modify):

- `.github/workflows/check.yml` (create)
- `package.json` (root; add `engines` only)
- `README.md` (the Develop section only)

**Out of scope** (do NOT touch, even though they look related):

- `bunfig.toml` — changing `exact` is a separate decision (recorded in `plans/README.md` as unplanned finding DEP-02).
- Any package `package.json` under `apps/` or `packages/`.
- Pre-commit hooks, husky, lint-staged — deliberately not added; CI is the gate.
- The 40 typecheck suggestions — a separate finding (DX-02); do not try to make CI fail on them.

## Git workflow

- Branch: `ci/check-workflow`
- Commit style is conventional commits, imperative, lowercase, e.g. `perf: load the chat and the gateway server only when used`. Use `ci: run bun run check on push and pull requests`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the workflow

Create `.github/workflows/check.yml` with exactly this content:

```yaml
name: check

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - run: bun install --frozen-lockfile
      # `prepare` patches TypeScript with the Effect language service; bun install
      # runs it already, and it is a no-op when the patch is in place.
      - run: bun run prepare
      - run: bun run check
```

**Verify**: `bun -e 'console.log(Object.keys(Bun.YAML.parse(await Bun.file(".github/workflows/check.yml").text())))'` → `[ "name", "on", "jobs" ]`

### Step 2: Declare the Bun version floor

In the root `package.json`, add an `engines` field directly after `"type": "module",`:

```json
"engines": {
  "bun": ">=1.4.0"
},
```

**Verify**: `bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).engines.bun)'` → `>=1.4.0`

**Verify**: `bun install --frozen-lockfile` → exit 0 (the lockfile must not change: `git diff --quiet bun.lock` → exit 0)

### Step 3: Tell contributors the prerequisite

In `README.md`, change the Develop section so the code block is preceded by one sentence: `Needs Bun 1.4 or newer.` Keep the code block itself unchanged.

**Verify**: `grep -n "Needs Bun 1.4" README.md` → one match

### Step 4: Run the whole check locally

**Verify**: `bun run check` → exit 0

## Test plan

No new tests: this plan adds infrastructure that runs the existing suite. The verification is the workflow file parsing and `bun run check` passing locally. If the operator allows a push, the first CI run on the branch is the end-to-end check; report its result.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/check.yml` exists and parses (Step 1 command prints `[ "name", "on", "jobs" ]`)
- [ ] `grep -c "bun run check" .github/workflows/check.yml` → `1`
- [ ] root `package.json` has `engines.bun` = `>=1.4.0`
- [ ] `git diff --quiet bun.lock` → exit 0 (lockfile untouched)
- [ ] `bun run check` exits 0
- [ ] `git status --short` shows only the three in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The root `package.json` scripts differ from the excerpt above (someone renamed `check`).
- `bun install --frozen-lockfile` fails or modifies `bun.lock` — the lockfile is out of date, which is a separate fix.
- `bun run check` fails locally before your change — report the failure; do not fix unrelated code.
- The operator's GitHub organisation disallows third-party actions (`oven-sh/setup-bun`); report and ask which runner image or action is allowed.

## Maintenance notes

- When the Bun version in `bun-version` is bumped, bump `engines.bun` and the README sentence together.
- If a later plan makes typecheck suggestions fatal (finding DX-02), it belongs in the `check` script, not in this workflow, so local and CI stay identical.
- Reviewers should confirm the workflow uses `--frozen-lockfile`; a CI that silently updates the lockfile hides dependency drift.
