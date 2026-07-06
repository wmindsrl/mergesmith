// Per-PR Slack thread: the first message about a PR opens a thread; every later event about
// the same PR is a reply in it, so the whole lifecycle (dispatch → CI → review → merge) lives
// in one place. Passive: mentions only when a human must act.
import type { MergesmithConfig } from './config.js';
import { addReaction, postSlack, removeReaction } from './slack.js';
import { getBranchThread, getThread, setThread } from './orchestrator/state.js';

// State → single emoji on the PR's ROOT (:rocket: Dispatch) message, so the channel list shows
// each PR's status at a glance without opening the thread. One state = one emoji: we add the new
// one and clear the others (Slack reactions accumulate otherwise).
const STATE_EMOJI = {
  merged: 'white_check_mark', //   ✅ mergiato
  rework: 'arrows_counterclockwise', // 🔄 rework in corso
  ci_red: 'red_circle', //          🔴 CI rossa
  needs_human: 'warning', //        ⚠️ serve un umano (needs-human / path critico)
  stalled: 'rotating_light', //     🚨 stallo / agent morto
} as const;
export type PrState = keyof typeof STATE_EMOJI;
const ALL_STATE_EMOJI: string[] = Object.values(STATE_EMOJI);

/**
 * Anchor the PR's thread to the ":rocket: Dispatch" message stashed by the dispatcher (keyed by
 * branch), if the PR has no thread yet. Call it as soon as (pr, branch) are known: every later
 * threadedPost replies under the dispatch message and the glance reaction lands on it.
 */
export function adoptBranchThread(config: MergesmithConfig, pr: number, branch: string): void {
  if (getThread(config.repo, pr)) return;
  const branchRoot = getBranchThread(config.repo, branch);
  if (branchRoot) setThread(config.repo, pr, branchRoot.ts, branchRoot.channel);
}

/** Set the glance-status reaction on the PR's root message. Best-effort (never aborts the loop). */
export async function setStateReaction(config: MergesmithConfig, pr: number, state: PrState): Promise<void> {
  const root = getThread(config.repo, pr);
  if (!root) return; // no thread anchored yet → nothing to react to
  const want = STATE_EMOJI[state];
  try {
    await addReaction(config.slack, root.channel, root.ts, want); // add first → no "no emoji" flicker
    for (const emoji of ALL_STATE_EMOJI) {
      if (emoji !== want) await removeReaction(config.slack, root.channel, root.ts, emoji);
    }
  } catch (err) {
    console.error(`Slack reaction (PR #${pr} → ${state}) fallita: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function threadedPost(
  config: MergesmithConfig,
  pr: number,
  text: string,
  opts?: { mention?: boolean; branch?: string },
): Promise<void> {
  // Best-effort: a failed notification must NEVER abort the verdict application (labels, merge,
  // follow-up already happened / still need to happen). Log and move on.
  try {
    let existing = getThread(config.repo, pr);
    if (!existing && opts?.branch) {
      // First message about this PR: adopt the ":rocket: Dispatch" message stashed by the
      // dispatcher (keyed by branch) as the PR's thread root, so the whole lifecycle threads
      // under the dispatch message and the glance-status reaction lands on it.
      const branchRoot = getBranchThread(config.repo, opts.branch);
      if (branchRoot) {
        setThread(config.repo, pr, branchRoot.ts, branchRoot.channel);
        existing = branchRoot;
      }
    }
    const res = await postSlack(config.slack, text, { mention: opts?.mention, threadTs: existing?.ts });
    if (!existing) setThread(config.repo, pr, res.ts, res.channel);
  } catch (err) {
    console.error(`Slack (PR #${pr}) fallito dopo retry: ${err instanceof Error ? err.message : String(err)}`);
  }
}
