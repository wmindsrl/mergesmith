# Changelog

All notable changes to `@wmind/mergesmith` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] — 2026-07-03

### Added
- **Kill switch** — `mergesmith pause` / `mergesmith resume` stop and restart the loop by
  writing/removing a `PAUSED` flag under `~/.mergesmith`, no crontab edit required. The tick
  short-circuits (skip) while the flag is present.
- **Health / heartbeat** — `mergesmith health` reports the target repo, pause state, and the
  age of the last successful tick. Each non-dry-run tick now writes a `heartbeat.json`
  (`lastTick` timestamp) per repo for dead-man's-switch checks.
- **`init` scaffolds `.github/workflows/ci.yml`** — a no-secret CI workflow whose job is named
  `ci` (the required status check the Mergesmith ruleset gates on), with `--if-present` steps so
  a fresh repo passes out of the box.

### Fixed
- **Multi-repo verifier `cwd`** — the verifier now runs in the target repo's local checkout via a
  new `VerifyInput.repoPath`, threaded from the repos registry through `tickAll` → `tickRepo`.
  Previously it always used `process.cwd()`, so in the multi-repo tick the reviewer could run
  against the wrong repository.

### Changed
- **Systemic tick-failure alert** — an uncaught error in a single-repo tick (e.g. an expired
  token making every call fail) now posts a `:rotating_light:` Slack alert (with mention) before
  rethrowing, instead of failing silently.

## [0.1.8] — 2026-07-03

### Added
- **`cursor-agent` verifier provider** — use Cursor Composer (`agent -p`) as the reviewer,
  inlining the command markdown as the prompt (`verifier.provider: cursor-agent`).

### Fixed
- **FAIL-CLOSED verdict validation** (shared `providers/verdict.ts`): a verdict that is missing
  or has a non-boolean `criticalPathHit` is now REJECTED — a critical-path PR can no longer slip
  past the human gate (previously fail-open). +6 unit tests.
- **No infinite re-review on APPROVE** — approve/auto-merge is wrapped so that when auto-merge
  isn't enabled or the PR isn't mergeable, the PR is flagged `needs-human` instead of re-running
  the full review every 20 minutes forever.
- **No @mention spam from dead agents** — on permanent follow-up failure (REQUEST_CHANGES and
  CI-red paths) the PR is marked reviewed + `needs-human` so it stops pinging every tick.
- **Tick skips `needs-human` PRs** — once a human owns a PR, pushes to it no longer trigger
  re-review or re-ping.
- **Atomic state writes** — `writeJson` writes to a temp file and renames, avoiding a truncated
  state file on crash or concurrent read.

## [0.1.7] — 2026-07-03

### Fixed
- Flag `needs-human` when the loop can't follow up: a PR that gets REQUEST_CHANGES or red CI but
  has no tracked implementer agent (legacy PR, or one opened outside `/dispatch`) is now labelled
  `needs-human` instead of being silently marked reviewed — no more invisible deadlocks.

## [0.1.6] — 2026-07-03

### Fixed
- Apply PR labels via the GitHub REST API (`issues/{n}/labels`) instead of `gh pr edit
  --add-label`, which exits 0 but silently no-ops (it queries the deprecated Projects-classic
  `projectCards` field via GraphQL).

## [0.1.5] — 2026-07-03

### Added
- `mergesmith init` now runs as the human admin's `gh` identity to: report the authenticated
  `gh` user (warning if not logged in), and apply the `mergesmith-main` branch ruleset via
  `gh api` (idempotent) — PR + code-owner review + status check `ci` + squash-only. It also
  creates the PR state labels. Remaining external-account steps (Cursor App install, bot
  collaborator, env, cron registration) are printed as manual instructions.

## [0.1.4] — 2026-07-03

### Added
- **`mergesmith dev-model [--list] [<model>]`** — get/set the implementer (Composer) model,
  symmetric to `verify-model`. The cursor provider can list `/v1/models`; overridable via the
  `MERGESMITH_IMPLEMENTER_MODEL` env var.

## [0.1.3] — 2026-07-03

### Added
- **`mergesmith ensure-labels`** — create the PR state labels idempotently.

### Fixed
- **Per-PR resilience in the tick** — `tickRepo` wraps each PR in try/catch so a transient
  fetch/`gh` failure on one PR no longer aborts the whole batch (found on the first live run).

## [0.1.2] — 2026-07-03

### Added
- First publish to the public npm registry (`@wmind/mergesmith`).
- Release workflow: any `v*` tag publishes to npmjs.org (dropped the GitHub Packages registry).

## [0.1.1] — 2026-07-03

### Added
- **Switchable review model** — `verifier.model` config + `MERGESMITH_VERIFIER_MODEL` env
  override → `claude --model`, plus `mergesmith verify-model [--list] [<model>]` to inspect and
  switch the review model.
- **Attribution** — the `Verdict` carries `{engine, model}`, rendered in the review body and
  Slack; `dispatch` also names the implementer engine/model.

### Fixed
- **Robust verdict delivery** — the command now writes a fixed `mergesmith-verdict.json` in the
  cwd and the provider reads it back from there, instead of relying on `$MERGESMITH_VERDICT`
  (the review sandbox blocks env-var reads). Fixes "no verdict produced" on every PR.

## [0.1.0] — 2026-07-03

### Added
- Initial scaffold of the Mergesmith agent-workflow framework: the rambase
  spec → implement → verify → merge loop extracted into a reusable, provider-agnostic framework
  (`@wmind/mergesmith` npm package + Claude Code plugin).
- Pluggable `ImplementerProvider` (Cursor) and `VerifierProvider` (Claude Code), selected from
  `mergesmith.config.json`.
- Thin verifier: emits a structured `Verdict`; the orchestrator (`act.ts`) does
  approve / merge / follow-up / labels / Slack in one provider-neutral place.
- CLI: `init`, `dispatch`, `tick [--all] [--dry-run]`, `followup`, `notify`, `mark-reviewed`.
- PR labels reflecting loop state (`mergesmith` / `mergesmith:ci-red` / `:rework` /
  `:needs-human` / `:approved`).
- CI without secrets, config-driven state under `~/.mergesmith`, 12 tests green.

[0.1.9]: https://github.com/wmindsrl/mergesmith/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/wmindsrl/mergesmith/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/wmindsrl/mergesmith/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/wmindsrl/mergesmith/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/wmindsrl/mergesmith/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/wmindsrl/mergesmith/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/wmindsrl/mergesmith/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/wmindsrl/mergesmith/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wmindsrl/mergesmith/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wmindsrl/mergesmith/releases/tag/v0.1.0
