# Mergesmith

**The smith that forges specs into merged PRs.**

[![npm](https://img.shields.io/npm/v/@wmind/mergesmith?style=flat-square)](https://www.npmjs.com/package/@wmind/mergesmith)
[![CI](https://img.shields.io/github/actions/workflow/status/wmindsrl/mergesmith/ci.yml?branch=main&style=flat-square)](https://github.com/wmindsrl/mergesmith/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/node/v/@wmind/mergesmith?style=flat-square)](./package.json)

Mergesmith is an orchestration framework for shipping code with AI agents on autopilot — with a
human gate where it matters. You write a Composer-ready spec; Mergesmith hands it to an
**implementer** engine that writes the code and opens a PR, then to a **verifier** engine that
reviews it adversarially. `APPROVE` auto-merges. `REQUEST_CHANGES` files an automatic follow-up
back to the implementer. Critical paths always route to a human.

Both engines are **pluggable**. The default implementer is Cursor Composer; the default verifier
is Claude Code. Swap either one by pointing `mergesmith.config.json` at a different provider.

---

## How it works

Mergesmith runs a closed loop. A scheduled `mergesmith tick` (cron) drives every agent-managed PR
one step forward each time it fires.

```
                          ┌───────────────────────────────────────────────┐
                          │                                               │
      spec.md ──▶ dispatch ──▶  IMPLEMENTER  ──▶  PR opened  ──┐          │
                          │   (Cursor Composer)                 │          │
                          │                                     ▼          │
                          │                              ┌─────────────┐   │
                    tick (cron, every N min) ──────────▶ │  VERIFIER   │   │
                          │                              │ (Claude Code)│   │
                          │                              └──────┬──────┘   │
                          │                                     │          │
                 ┌────────┴──────────┬──────────────────────────┼──────────┴────────┐
                 ▼                   ▼                           ▼                    ▼
             CI red            critical path?              REQUEST_CHANGES        APPROVE
                 │                   │ yes                       │                    │
                 ▼                   ▼                           ▼                    ▼
          wait / notify      needs-human gate            followup ─▶ IMPLEMENTER   squash-merge
                             (CODEOWNERS review)          (loops back into tick)
```

- **dispatch** parses the spec's frontmatter and sends it to the implementer, which opens a PR on a
  branch under the configured `branchPrefix` (e.g. `cursor/*`).
- **tick** is idempotent and safe to run on a cron. It only touches PRs Mergesmith owns (matching
  branch prefix or tracked state), advances each one, and posts CI/state changes to Slack.
- **verifier** runs the adversarial review and returns a verdict. On `APPROVE` with green CI and no
  critical paths touched, Mergesmith squash-merges. On `REQUEST_CHANGES`, it opens a follow-up so
  the implementer reworks the same branch.
- **human gate** — any PR that touches a `criticalPaths` entry requires a CODEOWNERS review before
  merge, regardless of verdict.

---

## Install

```bash
npm i -D @wmind/mergesmith
```

The verifier ships as a Claude Code plugin. Install it so `mergesmith tick` can invoke the review
command:

```bash
# inside Claude Code
/plugin install @wmind/mergesmith
```

Node ≥ 22.14 is required (see `engines` in `package.json`).

---

## Quick start

```bash
npx mergesmith init
```

`init` scaffolds everything needed to run the loop in your repo:

- **`mergesmith.config.json`** — the orchestrator config (see below).
- **`.github/CODEOWNERS`** — the human gate. Add the paths only a human may merge.
- **CI workflow** — a GitHub Actions workflow (name it in `ci.workflowName`) that runs your checks.
  Mergesmith reads its conclusion to decide whether a PR is mergeable.
- **Branch ruleset** — a repository ruleset that requires the CI workflow and CODEOWNERS review,
  so the loop can't merge red or ungated PRs even by mistake.

Then dispatch your first spec:

```bash
npx mergesmith dispatch docs/specs/0001-my-feature.md
```

and let the cron drive it:

```bash
# e.g. a crontab entry or CI schedule, every 20 minutes
npx mergesmith tick --all
```

---

## CLI

| Command | Description |
| --- | --- |
| `mergesmith init` | Scaffold config, CODEOWNERS, CI workflow and branch ruleset into the current repo. |
| `mergesmith dispatch <spec>` | Send a Composer-ready spec to the implementer, which opens a PR. |
| `mergesmith tick [--all] [--dry-run]` | Advance agent-managed PRs one step. `--all` processes every tracked PR; `--dry-run` prints the actions it would take without mutating anything. Designed to run on a cron. |
| `mergesmith followup --branch <b> --message "<m>"` | Manually queue a rework instruction to the implementer on branch `<b>` (the same mechanism `REQUEST_CHANGES` uses automatically). |
| `mergesmith notify "<text>" [--mention-marco]` | Post a message to the configured Slack channel. `--mention-marco` pings the human owner for actions that need a person (critical-path review, blocking decision). |

`--dry-run` on `tick` is the safe way to see what the loop is about to do — no PRs are merged, no
follow-ups are filed, no messages are sent.

---

## Configuration

`mergesmith.config.json` is the single source of truth for the loop. `init` writes a starter you
then fill in.

```json
{
  "repo": "wmindsrl/mergesmith",
  "base": "main",
  "specDir": "docs/specs",
  "ci": {
    "workflowName": "CI"
  },
  "slack": {
    "channel": "#dev",
    "webhookEnv": "SLACK_WEBHOOK_URL"
  },
  "implementer": {
    "provider": "cursor-composer",
    "model": "composer-1",
    "apiKeyEnv": "CURSOR_API_KEY",
    "branchPrefix": "cursor/"
  },
  "verifier": {
    "provider": "claude-code",
    "command": "claude -p /validate-pr"
  },
  "github": {
    "tokenEnv": "GH_TOKEN"
  },
  "contract": {
    "appendix": "docs/CONTRACT.md"
  },
  "criticalPaths": [
    ".github/**",
    "mergesmith.config.json",
    "db/migrations/**"
  ],
  "labels": {
    "prefix": "mergesmith"
  }
}
```

| Key | Meaning |
| --- | --- |
| `repo` | `owner/name` of the GitHub repository Mergesmith operates on. |
| `base` | Base branch PRs are opened against and merged into. |
| `specDir` | Directory `dispatch` resolves specs from. |
| `ci.workflowName` | Name of the GitHub Actions workflow whose conclusion gates merges. |
| `slack` | Channel and the env var holding the webhook/token used by `notify` and tick updates. |
| `implementer` | The engine that writes code. `provider` selects the plugin; `model`, `apiKeyEnv` and `branchPrefix` configure it. |
| `verifier` | The engine that reviews. `provider` selects the plugin; `command` is how it is invoked. |
| `github.tokenEnv` | Env var holding the token the bot uses (Write scope, no admin bypass). |
| `contract.appendix` | Path to a contract/appendix appended to every dispatch so the implementer follows house rules. |
| `criticalPaths` | Globs that force the human gate (CODEOWNERS review) regardless of verdict. |
| `labels.prefix` | Prefix for the loop-state labels (see below). |

Secrets are never stored in the config — only the **names** of env vars. Values are read from the
process environment, falling back to a local `.env.local` in the repo root.

---

## Labels

Mergesmith labels every agent-managed PR with the current state of the loop, so the queue is
legible at a glance from the GitHub PR list. The base label marks ownership; the suffixed labels
track where each PR is.

| Label | State |
| --- | --- |
| `mergesmith` | PR is agent-managed and tracked by the loop. |
| `mergesmith:ci-red` | CI is failing; the loop is waiting instead of merging. |
| `mergesmith:rework` | `REQUEST_CHANGES` verdict; a follow-up was filed and the implementer is reworking. |
| `mergesmith:needs-human` | A critical path was touched; a CODEOWNERS review is required before merge. |
| `mergesmith:approved` | `APPROVE` verdict with green CI; cleared to squash-merge. |

Labels are advisory state, not access control — the actual merge gate is the branch ruleset (CI +
CODEOWNERS). The label prefix is configurable via `labels.prefix`.

---

## Security

Mergesmith runs autonomous agents against your repository, so it is built to fail safe.

- **CI runs without secrets.** The gating workflow needs no repository secrets to reach a verdict —
  a PR from an agent branch can't exfiltrate credentials through CI, because there are none in that
  context. The Slack notifier is deliberately kept out of the secret-bearing path.
- **The bot has Write, never bypass.** The automation authenticates as a bot identity with Write
  permission only. It cannot bypass branch protection, cannot force-merge, and cannot override a
  required CODEOWNERS review. The human gate is enforced by the platform, not by the bot's good
  behavior.
- **Prompt-injection containment.** Spec text, PR bodies, diffs and CI logs are untrusted input.
  Slack markup from those sources is escaped before posting (no `<!channel>`/link spoofing), and the
  verifier treats PR-controlled content as data to review, not as instructions to obey.
- **Anti-self-modification.** Mergesmith's own configuration and control plane —
  `mergesmith.config.json`, `.github/**` (workflows, CODEOWNERS, rulesets) — are listed in
  `criticalPaths` by default. A PR that edits the rules of the loop cannot merge without a human,
  so an agent cannot widen its own permissions.

`tick --dry-run` lets you audit exactly what the loop would do before granting it the cron.

---

## Extending: writing a provider

The implementer and verifier are selected by `provider` in the config and resolved to plugins that
implement a small interface. Import the types from the `@wmind/mergesmith/providers` entrypoint.

```ts
import type { ImplementerProvider, VerifierProvider } from "@wmind/mergesmith/providers";

// An implementer turns a spec into an open PR on a fresh branch.
export const myImplementer: ImplementerProvider = {
  name: "my-implementer",
  async dispatch(spec, ctx) {
    // 1. create a branch under ctx.branchPrefix
    // 2. drive your engine to write the code from `spec`
    // 3. open a PR against ctx.base and return its number
    return { prNumber, branch };
  },
  async followup(branch, message, ctx) {
    // queue a rework instruction on an existing branch
  },
};

// A verifier reviews an open PR and returns a verdict.
export const myVerifier: VerifierProvider = {
  name: "my-verifier",
  async review(pr, ctx) {
    // inspect the diff/PR and decide
    return { verdict: "APPROVE" }; // or { verdict: "REQUEST_CHANGES", body }
  },
};
```

Register your provider's name in `implementer.provider` / `verifier.provider` and Mergesmith will
route the loop through it. The default `cursor-composer` and `claude-code` providers are shipped in
the package and are themselves just implementations of these interfaces — swap in your own engine
(a different agent, a local model, a human-in-a-terminal) without touching the orchestration loop.

---

## License

[MIT](./LICENSE) © 2026 Wmind S.r.l.
