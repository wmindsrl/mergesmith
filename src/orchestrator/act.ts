// Provider-neutral side-effects: turn a Verdict into GitHub actions + labels + Slack.
// Every verifier funnels through here, so merge/gate policy lives in exactly one place.
import type { MergesmithConfig } from '../config.js';
import { addLabels, approve, comment, mergeAuto, removeLabels, requestChanges } from '../github.js';
import { postSlack } from '../slack.js';
import { getImplementer } from '../providers/registry.js';
import { FollowupError, type Verdict } from '../providers/types.js';
import { markReviewed, refForBranch } from './state.js';

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

// " (claude-code/opus)" — which engine+model produced the verdict.
function attributionSuffix(verdict: Verdict): string {
  const a = verdict.attribution;
  if (!a) return '';
  return a.model ? ` (${a.engine}/${a.model})` : ` (${a.engine})`;
}

function verdictBody(verdict: Verdict): string {
  const lines = [verdict.rationale];
  if (verdict.comments.length > 0) {
    lines.push('');
    for (const c of verdict.comments) {
      lines.push(`- \`${c.path}${c.line ? `:${c.line}` : ''}\` — ${c.body}`);
    }
  }
  if (verdict.attribution) lines.push('', `— verified by${attributionSuffix(verdict)}`);
  return lines.join('\n');
}

export async function applyVerdict(
  config: MergesmithConfig,
  pr: number,
  sha: string,
  branch: string,
  verdict: Verdict,
): Promise<void> {
  const L = config.labels;
  const setLabels = (add: string[], remove: string[]): void => {
    if (!L.enabled) return;
    addLabels(config, pr, add);
    removeLabels(config, pr, remove);
  };

  if (verdict.decision === 'REQUEST_CHANGES') {
    requestChanges(config, pr, verdictBody(verdict));
    setLabels([L.rework], [L.approved, L.needsHuman]);

    const ref = refForBranch(config.repo, branch);
    if (!ref) {
      markReviewed(config.repo, pr, sha);
      await postSlack(
        config.slack,
        `:warning: REQUEST_CHANGES PR #${pr} pubblicato ma nessun agent noto per \`${branch}\` — follow-up manuale`,
        { mention: true },
      );
      return;
    }
    try {
      await getImplementer(config).followup(ref, verdict.followupMessage ?? verdict.rationale);
      markReviewed(config.repo, pr, sha);
      await postSlack(config.slack, `:no_entry: REQUEST_CHANGES PR #${pr} — ${firstLine(verdict.rationale)}${attributionSuffix(verdict)}`);
    } catch (error) {
      if (error instanceof FollowupError && error.kind === 'busy') {
        // Do NOT mark the SHA: the tick retries next round (dedup avoids duplicate comments).
        await postSlack(config.slack, `:hourglass: PR #${pr}: REQUEST_CHANGES su GitHub ma agent occupato — retry al prossimo tick`);
        return;
      }
      markReviewed(config.repo, pr, sha);
      await postSlack(config.slack, `:warning: PR #${pr}: follow-up fallito (${String(error)})`, { mention: true });
    }
    return;
  }

  // APPROVE
  if (verdict.criticalPathHit) {
    comment(
      config,
      pr,
      `Mergesmith — il verifier approva ma il diff tocca un path critico (CODEOWNERS): serve review umana.\n\n${verdictBody(verdict)}`,
    );
    setLabels([L.needsHuman], [L.rework]);
    markReviewed(config.repo, pr, sha);
    await postSlack(config.slack, `:hourglass: PR #${pr} ok per il verifier ma tocca un path critico: serve la tua review${attributionSuffix(verdict)}`, {
      mention: true,
    });
    return;
  }

  approve(config, pr, verdictBody(verdict));
  mergeAuto(config, pr);
  setLabels([L.approved], [L.rework, L.needsHuman]);
  markReviewed(config.repo, pr, sha);
  await postSlack(config.slack, `:white_check_mark: APPROVE PR #${pr} — auto-merge attivo${attributionSuffix(verdict)}`);
}
