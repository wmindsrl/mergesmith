// Per-PR Slack thread: the first message about a PR opens a thread; every later event about
// the same PR is a reply in it, so the whole lifecycle (dispatch → CI → review → merge) lives
// in one place. Passive: mentions only when a human must act.
import type { MergesmithConfig } from './config.js';
import { postSlack } from './slack.js';
import { getThread, setThread } from './orchestrator/state.js';

export async function threadedPost(
  config: MergesmithConfig,
  pr: number,
  text: string,
  opts?: { mention?: boolean },
): Promise<void> {
  // Best-effort: a failed notification must NEVER abort the verdict application (labels, merge,
  // follow-up already happened / still need to happen). Log and move on.
  try {
    const existing = getThread(config.repo, pr);
    const res = await postSlack(config.slack, text, { mention: opts?.mention, threadTs: existing?.ts });
    if (!existing) setThread(config.repo, pr, res.ts, res.channel);
  } catch (err) {
    console.error(`Slack (PR #${pr}) fallito dopo retry: ${err instanceof Error ? err.message : String(err)}`);
  }
}
