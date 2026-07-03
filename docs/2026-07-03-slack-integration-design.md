# Mergesmith — Slack integration design

**Status:** implemented (v0.3.0). This documents the design as built; the original spec was
drafted, approved, then lost in a branch switch and is reconstructed here.

## Goal

Make Slack the human's interface to the loop, without adding an inbound server. Three capabilities,
all poll-based (symmetric with the tick):

1. **Threading** — every event about a PR lives in one Slack thread; mentions only when a human
   must act.
2. **Inbox (Slack → issue)** — a channel thread is where a bug/feature is discussed; an allowed
   user replies with a trigger (`!go`) to finalize it into a GitHub issue the loop dispatches.
3. **Recap** — a scannable state snapshot (PRs by state + issues by label), on-demand or scheduled.

Constraint carried from the rambase design: **no webhook, no inbound listener.** Everything is a
poll driven by the same cron that runs the tick. This keeps the deployment a single cron entry with
no public surface.

## 1. Threading

State gains a per-repo `threads: { "pr:<n>": {ts, channel} }` map. `threadedPost(config, pr, text,
{mention})` (in `src/thread.ts`) get-or-creates the PR's thread: the first message about a PR is
the root, every later one is a reply under it. `act.ts` (verdict/merge/needs-human) and
`tick.handleCiRed` route through it; `reportStuckRuns` (not tied to a PR) stays a standalone post.

Mention policy is unchanged: `{mention: true}` only on events that need a human (needs-human,
critical-path, follow-up failure, merge failure). Routine events (APPROVE, REQUEST_CHANGES sent,
CI-red follow-up sent) thread silently.

Not linked yet: the dispatch message (posted before the PR exists) and the inbox confirmation live
in their own thread, separate from the PR thread. Linking dispatch→PR is a possible enhancement
(map branch→dispatch-ts, adopt it as the PR thread root) — deferred as non-essential.

## 2. Inbox (Slack → issue)

`src/inbox.ts`, run each tick (before `runReadyIssues`, so a fresh issue is dispatched the same
cycle) and available on-demand as `mergesmith inbox`.

**Flow:** discuss in a channel thread → an allowed user replies `!go` → next poll:
- read the thread, synthesize a clean issue via `verifier.synthesize` (a tool-free one-shot on the
  configured verifier engine — `claude -p` / `agent -p` — returning `{title, body}` JSON),
- create it labelled `ready` (→ dispatched), react 👀→✅ on the trigger, reply in-thread with the
  issue link, credit the reporter (thread root author) + finalizer (`!go` author).

**Security — fail-closed.** Opt-in (`slack.inbox.enabled`, default `false`). Only user IDs in
`slack.inbox.allowedUsers` can trigger (fallback: the mention user; if neither, the inbox logs and
does nothing — it never dispatches work for an unauthorized user).

**No flood on enable.** First poll with no cursor *bootstraps*: it adopts the current high-water
mark without acting, so pre-existing `!go` messages don't retroactively create issues. Only triggers
newer than the cursor count. A per-thread `processed` set dedups (one issue per thread).

**No silent failure.** If synthesis is unavailable or unparseable, the issue is still created from
the raw thread (title = first line, body = discussion) and the degradation is flagged in the Slack
reply ("issue grezza, rivedila") — the work is never lost, and the fallback is visible.

**Slack transport.** Read methods (`conversations.history`/`replies`, `users.info`) are called
form-encoded — Slack ignores a JSON body on those. `chat.postMessage` stays JSON (long text).

## 3. Recap

`src/recap.ts`. `formatRecap` (pure) renders open agent-managed PRs by derived state
(needs-human > rework > ci-red > approved > in-review) and issues by label (ready / in-progress /
needs-triage), or "niente in coda" when empty. `mergesmith recap` posts it on demand; a daily recap
is a separate cron entry calling the same command.

## 4. Skill

`plugin/commands/mergesmith-issue.md` — the in-session complement to the inbox: turn a request into
a well-formed `ready`/`needs-triage` issue from within a Claude Code session (drafts title+body
against the codebase, gets approval, `gh issue create`).

## Config surface

```jsonc
"slack": {
  "botTokenEnv": "SLACK_BOT_TOKEN",
  "channelEnv": "SLACK_CHANNEL_DEV",
  "mentionUserIdEnv": "SLACK_MENTION_USER_ID",
  "inbox": {
    "enabled": true,
    "allowedUsers": ["U0123ABC"],   // Slack user IDs allowed to !go
    "trigger": "!go"
  }
}
```

## Testing

Pure helpers are unit-tested (`test/inbox.test.ts`, `test/recap.test.ts`, `test/state.test.ts`):
trigger detection, trigger stripping, allowlist, balanced-JSON extraction, thread rendering, recap
formatting/state priority, thread-state round-trip + no-clobber. IO paths (Slack API, gh) are thin
wrappers exercised live.
