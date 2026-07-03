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

Both engines are **pluggable**. The default implementer is **Cursor** (Cursor Cloud Agents API);
the default verifier is **Claude Code**, with **Cursor Agent** (Composer as reviewer) available as
an alternative. Swap either one by pointing `mergesmith.config.json` at a different provider.

---

## How it works

Mergesmith runs a closed loop. A scheduled `mergesmith tick` (cron) drives every agent-managed PR
one step forward each time it fires.

```
                          ┌───────────────────────────────────────────────┐
                          │                                               │
      spec.md ──▶ dispatch ──▶  IMPLEMENTER  ──▶  PR opened  ──┐          │
                          │      (Cursor)                       │          │
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

- **dispatch** sends the spec to the implementer, which opens a PR on a branch under the configured
  `branchPrefix` (e.g. `cursor/*`).
- **tick** is idempotent and safe to run on a cron. It only touches PRs Mergesmith owns (matching
  branch prefix or tracked state), advances each one, and posts CI/state changes to Slack.
- **verifier** runs the adversarial review in a fresh headless session and writes a structured
  `Verdict`. On `APPROVE` with green CI and no critical paths touched, Mergesmith squash-merges. On
  `REQUEST_CHANGES`, it files a follow-up so the implementer reworks the same branch.
- **human gate** — any PR whose diff touches a path listed in the repo's CODEOWNERS requires a
  CODEOWNERS review before merge, regardless of verdict. The verifier flags this as
  `criticalPathHit` and the branch ruleset enforces it.

The verifier stays **thin**: it judges only and emits a `mergesmith-verdict.json`. The orchestrator
turns that verdict into GitHub actions (merge / label / follow-up).

---

## Install

Mergesmith ships as an npm package:

```bash
npm i -D @wmind/mergesmith
```

Node **≥ 22.14** is required (see `engines` in `package.json`).

### Install the review command into the consumer repo

The verifier runs a **review command** (a Markdown prompt) inside your repo. It is **not** a
Claude Code plugin you install globally — copy the shipped command file into your repo's command
directory so the verifier can resolve it:

```bash
# Claude Code verifier (default) → .claude/commands/
mkdir -p .claude/commands
cp node_modules/@wmind/mergesmith/plugin/commands/validate-pr.md \
   .claude/commands/mergesmith-validate-pr.md

# Cursor Agent verifier → .cursor/commands/
mkdir -p .cursor/commands
cp node_modules/@wmind/mergesmith/plugin/commands/validate-pr.md \
   .cursor/commands/mergesmith-validate-pr.md
```

The filename you copy to must match `verifier.command` in the config. With the default
`"command": "/mergesmith-validate-pr"`, the file is `mergesmith-validate-pr.md`.

- **claude-code** runs `claude -p "/mergesmith-validate-pr <pr>"`, which resolves the slash command
  from `.claude/commands/`.
- **cursor-agent** reads the Markdown file directly (from `.cursor/commands/`, falling back to
  `.claude/commands/`), strips its frontmatter, and passes the body as the prompt to `agent -p`.

> `/plugin install @wmind/mergesmith` does **not** work — there is no global plugin registration.
> The review command is a repo-local file, as above.

---

## Quick start

```bash
npx mergesmith init
```

`init` scaffolds everything needed to run the loop in your repo (existing files are left untouched):

- **`mergesmith.config.json`** — the orchestrator config (see below).
- **`.github/CODEOWNERS`** — the human gate. Its non-comment paths are the critical paths.
- **`.github/workflows/ci.yml`** — a no-secret CI workflow (job named `ci`) whose conclusion gates
  merges. Customize the steps for your stack.
- **`docs/agents/CONTRACT.md`** — the repo's contract appendix (domain review policy).
- **`.github/mergesmith-ruleset.json`** + an applied branch ruleset — requires the `ci` status check
  and a CODEOWNERS review and restricts merges to squash, so the loop can't merge red or ungated
  PRs even by mistake.

`init` also creates the PR state labels. It runs as **your** `gh` identity and needs repo **ADMIN**
to apply the ruleset. It then prints a checklist of steps it cannot do for you: fill in the config,
install the Cursor GitHub App on the org, add the automation bot as a **Write** collaborator, set
the env vars, and register the repo for the cron in `~/.mergesmith/repos.json`.

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
| `mergesmith init` | Scaffold config, CODEOWNERS, CI workflow, contract appendix and branch ruleset into the current repo; create the state labels. |
| `mergesmith dispatch <spec>` | Send a Composer-ready spec to the implementer, which opens a PR. |
| `mergesmith tick [--all] [--dry-run]` | Advance agent-managed PRs one step. `--all` processes every repo registered in `~/.mergesmith/repos.json`; `--dry-run` prints the actions it would take without mutating anything. Designed to run on a cron. |
| `mergesmith followup --branch <b> --message "<m>"` | Manually queue a rework instruction to the implementer on branch `<b>` (the same mechanism `REQUEST_CHANGES` uses automatically). |
| `mergesmith notify "<text>" [--mention]` | Post a message to the configured Slack channel via `chat.postMessage`. `--mention` pings the human owner (`mentionUserIdEnv`) for actions that need a person. |
| `mergesmith inbox` | Poll Slack for `!go`-finalized threads and turn each into a `ready` GitHub issue (the tick runs this every cycle; the command is for manual/testing runs). See [Slack inbox](#slack-inbox). |
| `mergesmith recap` | Post a state snapshot to Slack — open agent-managed PRs by state + issues by label. On-demand; schedule a separate cron for a daily recap. |
| `mergesmith mark-reviewed <pr> <sha>` | Mark a PR SHA as already processed (skip it on the next tick). |
| `mergesmith verify-model [--list] [<model>]` | Get, list, or set the **review** model. Writes `verifier.model` to the config; `--list` shows the verifier engine's models. |
| `mergesmith dev-model [--list] [<model>]` | Get, list, or set the **implementer** model. Writes `implementer.model` to the config; `--list` shows the implementer engine's models. |
| `mergesmith ensure-labels` | Create the five PR state labels in the repo (idempotent). |
| `mergesmith pause` / `mergesmith resume` | Kill switch: pause creates a global `PAUSED` flag so every tick skips all work; resume removes it. No crontab edit needed. |
| `mergesmith health` | Show the repo, the pause state, and the last successful tick heartbeat. |

`--dry-run` on `tick` is the safe way to see what the loop is about to do — no PRs are merged, no
follow-ups are filed, no messages are sent.

A quick per-run model override is also possible via env without editing the config:
`MERGESMITH_IMPLEMENTER_MODEL` and `MERGESMITH_VERIFIER_MODEL` (read from the environment or a local
`.env.local`).

---

## Configuration

`mergesmith.config.json` is the single source of truth for the loop. `init` writes a starter you
then fill in. `repo`, `implementer.provider` and `verifier.provider` are required; everything else
has a default.

```json
{
  "repo": "OWNER/REPO",
  "base": "main",
  "specDir": "docs/specs",
  "ci": { "workflowName": "CI" },
  "slack": {
    "botTokenEnv": "SLACK_BOT_TOKEN",
    "channelEnv": "SLACK_CHANNEL_DEV",
    "mentionUserIdEnv": "SLACK_MENTION_USER_ID",
    "inbox": { "enabled": false, "allowedUsers": [], "trigger": "!go" }
  },
  "implementer": {
    "provider": "cursor",
    "model": "composer-2.5",
    "apiKeyEnv": "CURSOR_API_KEY",
    "branchPrefix": "cursor/"
  },
  "verifier": {
    "provider": "claude-code",
    "command": "/mergesmith-validate-pr",
    "model": "opus"
  },
  "github": { "tokenEnv": "GH_TOKEN_MERGESMITH" },
  "contract": { "appendix": "docs/agents/CONTRACT.md" },
  "criticalPaths": ".github/CODEOWNERS",
  "labels": {
    "enabled": true,
    "managed": "mergesmith",
    "ciRed": "mergesmith:ci-red",
    "rework": "mergesmith:rework",
    "needsHuman": "mergesmith:needs-human",
    "approved": "mergesmith:approved"
  }
}
```

| Key | Meaning |
| --- | --- |
| `repo` | `owner/name` of the GitHub repository Mergesmith operates on. **Required.** |
| `base` | Base branch PRs are opened against and merged into. Default `main`. |
| `specDir` | Directory your specs live in. `dispatch` takes a path to a spec. |
| `ci.workflowName` | Name of the GitHub Actions workflow whose conclusion gates merges. Default `CI`. |
| `slack.botTokenEnv` | Env var holding the Slack **bot token** used for `chat.postMessage`. Default `SLACK_BOT_TOKEN`. |
| `slack.channel` / `slack.channelEnv` | Target channel, either inline or via env var. Default `channelEnv` = `SLACK_CHANNEL_DEV`. |
| `slack.mentionUserIdEnv` | Env var with the Slack user id pinged by `notify --mention`. Default `SLACK_MENTION_USER_ID`. |
| `slack.inbox.enabled` | Turn on the [Slack inbox](#slack-inbox) (`!go`-finalized threads → issues). Default `false` (opt-in). |
| `slack.inbox.allowedUsers` | Slack user IDs allowed to finalize a thread with the trigger. **Fail-closed**: if empty, the inbox falls back to the mention user, and if that too is absent it does nothing. |
| `slack.inbox.trigger` | The reply text that finalizes a thread. Default `!go`. |
| `implementer.provider` | The engine that writes code. **Required.** Currently: `cursor`. |
| `implementer.model` | Model id for the implementer (e.g. `composer-2.5`). |
| `implementer.apiKeyEnv` | Env var with the implementer API key. Default `CURSOR_API_KEY`. |
| `implementer.branchPrefix` | Branch prefix the implementer uses; the tick treats matching PRs as agent-managed. Default `cursor/`. |
| `verifier.provider` | The engine that reviews. **Required.** One of `claude-code`, `cursor-agent`. |
| `verifier.command` | Review command the verifier runs. A slash command name (e.g. `/mergesmith-validate-pr`) or a Markdown path. **Do not** include `claude -p` / `agent -p` — the provider prepends the runner. |
| `verifier.model` | Model override for the review (`opus`, `sonnet`, … for claude-code; a Cursor model for cursor-agent). |
| `verifier.apiKeyEnv` | Env var for the Cursor key when `provider` is `cursor-agent`. Defaults to `implementer.apiKeyEnv`. |
| `github.tokenEnv` | Env var holding the bot's GitHub token (Write scope, no admin bypass). Default `GH_TOKEN_MERGESMITH`. |
| `contract.appendix` | Path to the repo's contract appendix, appended to every dispatch so the implementer follows house rules. Default `docs/agents/CONTRACT.md`. |
| `criticalPaths` | Path to the **CODEOWNERS file** whose non-comment entries define the human-gate paths. A single string, not a list. Default `.github/CODEOWNERS`. |
| `labels` | The five loop-state labels (see below), with explicit names + an `enabled` flag. |

Secrets are never stored in the config — only the **names** of env vars. Values are read from the
process environment, falling back to a local `.env.local` in the repo root.

---

## Verifier engines

| Provider | Runner | How the command is resolved |
| --- | --- | --- |
| `claude-code` (default) | `claude -p "<command> <pr>" --permission-mode acceptEdits` | A Claude Code slash command resolved from `.claude/commands/` (e.g. `/mergesmith-validate-pr`). Model via `--model` — `opus`, `sonnet`, `haiku`, `fable`. |
| `cursor-agent` (alias `cursor`) | `agent -p "<prompt>"` (Cursor Composer as reviewer) | The command resolves to a Markdown file under `.cursor/commands/` (fallback `.claude/commands/`); its frontmatter is stripped and the body is used as the prompt. Uses `verifier.apiKeyEnv` (defaults to the implementer's `CURSOR_API_KEY`). |

Both engines run in a fresh headless session and write `mergesmith-verdict.json` in the repo root,
which the orchestrator reads back, validates, and acts on. Switch engines by changing
`verifier.provider`; switch models with `mergesmith verify-model <model>` (or the
`MERGESMITH_VERIFIER_MODEL` env override).

---

## Labels

Mergesmith labels every agent-managed PR with the current state of the loop, so the queue is
legible at a glance from the GitHub PR list. Each label name is set explicitly in `labels`
(defaults shown); there is no shared prefix key.

| Config key | Default label | State |
| --- | --- | --- |
| `labels.managed` | `mergesmith` | PR is agent-managed and tracked by the loop. |
| `labels.ciRed` | `mergesmith:ci-red` | CI is failing; the loop is waiting instead of merging. |
| `labels.rework` | `mergesmith:rework` | `REQUEST_CHANGES` verdict; a follow-up was filed and the implementer is reworking. |
| `labels.needsHuman` | `mergesmith:needs-human` | A critical path was touched; a CODEOWNERS review is required before merge. |
| `labels.approved` | `mergesmith:approved` | `APPROVE` verdict with green CI; cleared to squash-merge. |

Set `labels.enabled: false` to skip labeling entirely. Labels are advisory state, not access
control — the actual merge gate is the branch ruleset (CI + CODEOWNERS). Create/repair them any
time with `mergesmith ensure-labels`.

---

## Slack inbox

Beyond notifications, Slack can be the **work intake**: discuss a bug or feature in a channel
thread, then an authorized person replies `!go` to turn that thread into a GitHub issue the loop
picks up. Poll-based — no webhook, no inbound server; the same cron that runs the tick drives it.

**Flow.** Someone posts the problem → the team discusses in the thread → an allowed user replies
`!go` → on the next tick Mergesmith reads the thread, synthesizes a clean issue (title + body:
context, what to do, acceptance criteria) on the configured verifier engine, creates it labelled
`ready` (so it's dispatched the same cycle), reacts 👀→✅ on the trigger, and replies in-thread with
the issue link — crediting the reporter and the finalizer.

**Enable it** in `slack.inbox`:

```jsonc
"inbox": { "enabled": true, "allowedUsers": ["U0123ABC"], "trigger": "!go" }
```

- **Opt-in + fail-closed.** Off by default. Only `allowedUsers` (Slack user IDs) can finalize a
  thread; empty falls back to the mention user, and if that's absent too the inbox does nothing —
  it never dispatches work for an unauthorized user.
- **No flood on enable.** The first poll bootstraps a cursor at the current high-water mark without
  acting, so pre-existing `!go` messages don't retroactively create issues. One issue per thread
  (deduped).
- **No silent failure.** If synthesis is unavailable or unparseable, the issue is still created
  from the raw thread and the degradation is flagged in the Slack reply — the work is never lost.

The in-session complement is the `/mergesmith-issue` plugin command: draft a `ready`/`needs-triage`
issue from within a Claude Code session. See
[`docs/2026-07-03-slack-integration-design.md`](docs/2026-07-03-slack-integration-design.md) for the
full design.

---

## Security

Mergesmith runs autonomous agents against your repository, so it is built to fail safe.

- **CI runs without secrets.** The scaffolded gating workflow needs no repository secrets to reach a
  verdict — a PR from an agent branch can't exfiltrate credentials through CI, because there are
  none in that context. The Slack notifier is deliberately kept out of the secret-bearing path.
- **The bot has Write, never bypass.** The automation authenticates as a bot identity with Write
  permission only. It cannot bypass branch protection, cannot force-merge, and cannot override a
  required CODEOWNERS review. The human gate is enforced by the platform, not by the bot's good
  behavior.
- **Prompt-injection containment.** Spec text, PR bodies, diffs and CI logs are untrusted input.
  Slack markup from those sources is escaped before posting (no `<!channel>`/link spoofing), and the
  verifier treats PR-controlled content as data to review, not as instructions to obey.
- **Anti-self-modification.** Add Mergesmith's own control plane —
  `mergesmith.config.json`, `.github/**` (workflows, CODEOWNERS, rulesets) — to CODEOWNERS so a PR
  that edits the rules of the loop cannot merge without a human. An agent can't widen its own
  permissions.
- **Kill switch.** `mergesmith pause` drops a global `PAUSED` flag that halts every tick without
  touching crontab; `mergesmith resume` lifts it.

`tick --dry-run` lets you audit exactly what the loop would do before granting it the cron.

---

## Extending: writing a provider

The implementer and verifier are selected by `provider` in the config and resolved in
`src/providers/registry.ts`. Adding an engine = a new `case` there plus a factory file implementing
one of the two small interfaces. Import the types from the `@wmind/mergesmith/providers` entrypoint.

```ts
import type {
  ImplementerProvider,
  VerifierProvider,
  DispatchInput,
  DispatchResult,
  VerifyInput,
  Verdict,
  AgentRef,
} from "@wmind/mergesmith/providers";

// An implementer turns a spec into an open PR on a fresh branch.
export function createMyImplementer(): ImplementerProvider {
  return {
    id: "my-implementer",
    branchPrefix: "mybot/", // the tick treats matching PRs as agent-managed
    async dispatch(input: DispatchInput): Promise<DispatchResult> {
      // input: { specText, specPath, repo, base, contractRef, model? }
      // 1. drive your engine to write the code from the spec
      // 2. open a PR against input.base on a branch under branchPrefix
      const ref: AgentRef = { provider: "my-implementer", agentId /*, runId */ };
      return { ref, branch, prUrl };
    },
    async followup(ref, message) {
      // queue a rework instruction on the existing run/branch
    },
    async status(ref) {
      return { state: "running", branch, prUrl }; // 'running' | 'finished' | 'error' | 'expired'
    },
    // async listModels() { return ["…"]; } // optional, powers `dev-model --list`
  };
}

// A verifier reviews an open PR and returns a Verdict. It must NOT touch GitHub —
// the orchestrator applies the verdict.
export function createMyVerifier(): VerifierProvider {
  return {
    id: "my-verifier",
    async verify(input: VerifyInput): Promise<Verdict> {
      // input: { prNumber, repo, base, contractRef, codeownersPath, repoPath? }
      return {
        decision: "APPROVE", // or "REQUEST_CHANGES"
        criticalPathHit: false, // true when the diff touches a CODEOWNERS path
        comments: [], // [{ path, line?, body }]
        rationale: "…",
        // followupMessage: "…", // sent to the implementer on REQUEST_CHANGES
        // attribution: { engine: "my-verifier", model: "…" },
      };
    },
    // async listModels() { return ["…"]; } // optional, powers `verify-model --list`
  };
}
```

Wire your factory into `getImplementer` / `getVerifier` in `src/providers/registry.ts`. The shipped
`cursor` (implementer) and `claude-code` / `cursor-agent` (verifiers) providers are themselves just
implementations of these interfaces — swap in your own engine (a different agent, a local model, a
human-in-a-terminal) without touching the orchestration loop.

---

## License

[MIT](./LICENSE) © 2026 Wmind S.r.l.
