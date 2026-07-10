// Provider-neutral side-effects: turn a Verdict into GitHub actions + labels + Slack.
// Every verifier funnels through here, so merge/gate policy lives in exactly one place.
import type { MergesmithConfig } from '../config.js';
import { addLabels, approve, comment, commentWithId, mergeAuto, prMergeable, removeLabels, requestChanges } from '../github.js';
import { adoptBranchThread, setStateReaction, threadedPost } from '../thread.js';
import { getImplementer } from '../providers/registry.js';
import { FollowupError, type DecisionQuestion, type Verdict } from '../providers/types.js';
import {
  bumpReworkRound,
  clearLastVerdict,
  clearReworkRound,
  issueForBranch,
  markIssueDone,
  markReviewed,
  refForBranch,
  setDecision,
  setLastVerdict,
  setRefForBranch,
  setRework,
} from './state.js';

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

// The owner question as PR-comment markdown: options as a bullet list, recommended starred.
function renderQuestion(q: DecisionQuestion): string {
  const lines = [`**${q.text}**`];
  if (q.options?.length) {
    lines.push('');
    for (const o of q.options) {
      lines.push(`- **${o.key}** — ${o.label}${o.recommended ? ' ⭐ _consigliata_' : ''}`);
    }
  }
  return lines.join('\n');
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
  // Anchor this PR's Slack thread to its ":rocket: Dispatch" message (if stashed by the
  // dispatcher) before any threadedPost/reaction below — the whole lifecycle threads under it.
  adoptBranchThread(config, pr, branch);
  const L = config.labels;
  const setLabels = (add: string[], remove: string[]): void => {
    if (!L.enabled) return;
    addLabels(config, pr, add);
    removeLabels(config, pr, remove);
  };

  if (verdict.decision === 'REQUEST_CHANGES') {
    requestChanges(config, pr, verdictBody(verdict));
    setLabels([L.rework], [L.approved, L.needsHuman]);
    // Re-review context for the next round: the verifier judges ONLY these blockers + the delta.
    setLastVerdict(config.repo, pr, { sha, verdict });
    // Trickle alarm: from round 3 the review ping-pong is costing hours — ping the owner, who can
    // often unblock with one decision.
    const rounds = bumpReworkRound(config.repo, pr);

    const fixPrompt = verdict.followupMessage ?? verdict.rationale;
    const impl = getImplementer(config);
    const ref = refForBranch(config.repo, branch);
    try {
      if (ref) {
        await impl.followup(ref, fixPrompt);
      } else if (impl.adoptBranch) {
        // No tracked agent → spawn a FRESH one on the branch to drive the rework (the tick then
        // watches it and auto-recovers again if it stalls). No more silent needs-human here.
        const res = await impl.adoptBranch(config.repo, branch, fixPrompt);
        setRefForBranch(config.repo, branch, res.ref);
      } else {
        throw new Error(`nessun agent noto per ${branch} e il provider non supporta adoptBranch`);
      }
      markReviewed(config.repo, pr, sha);
      // Arm the rework watchdog: the tick verifies this follow-up lands a new SHA, else recovers.
      setRework(config.repo, pr, { sha, followupAt: Date.now(), attempts: 0, fixPrompt });
      const trickle = rounds >= 3 ? ` — :rotating_light: ${rounds}° round: se c'è una scelta che puoi sbloccare tu, rispondi sulla PR` : '';
      await threadedPost(
        config,
        pr,
        `:no_entry: REQUEST_CHANGES PR #${pr} (round ${rounds}) — ${firstLine(verdict.rationale)}${attributionSuffix(verdict)}${trickle}`,
        { mention: rounds >= 3 },
      );
      await setStateReaction(config, pr, 'rework');
    } catch (error) {
      if (error instanceof FollowupError && (error.kind === 'busy' || error.kind === 'transient')) {
        // The review is already on GitHub — persist the verdict and retry ONLY the delivery next
        // tick (issue #1: re-verifying here re-ran a full LLM session and posted a duplicate
        // CHANGES_REQUESTED review every tick).
        markReviewed(config.repo, pr, sha);
        setRework(config.repo, pr, { sha, followupAt: Date.now(), attempts: 0, fixPrompt, delivered: false });
        const why = error.kind === 'busy' ? 'agent occupato' : 'errore di rete transitorio';
        await threadedPost(
          config,
          pr,
          `:hourglass: PR #${pr}: REQUEST_CHANGES su GitHub ma follow-up non consegnato (${why}) — riprovo solo la consegna al prossimo tick`,
        );
        await setStateReaction(config, pr, 'rework');
        return;
      }
      // Couldn't start the rework (no agent + adopt failed / permanent error) → a human must look.
      if (L.enabled) addLabels(config, pr, [L.needsHuman]);
      markReviewed(config.repo, pr, sha);
      await threadedPost(config, pr, `:warning: PR #${pr}: rework non avviabile (${String(error)}) — flaggata needs-human`, {
        mention: true,
      });
      await setStateReaction(config, pr, 'needs_human');
    }
    return;
  }

  if (verdict.decision === 'NEEDS_DECISION') {
    // The blocker is a CHOICE (workaround accettabile? approccio A o B?), not a defect: don't
    // ping-pong with the implementer — ask the code-owner ONE question on the PR, notify Slack,
    // and park until the answer lands. The answer re-triggers a (fast, delta-scoped) re-verify.
    const q = verdict.question!; // fail-closed validated by readVerdict
    const body = [
      '## :vertical_traffic_light: Mergesmith — serve una tua decisione',
      '',
      verdict.rationale,
      '',
      renderQuestion(q),
      '',
      q.options?.length
        ? `_Rispondi con un commento qui sotto: la lettera dell'opzione (es. \`${q.options[0]!.key}\`) o testo libero. Il loop riprende da solo._`
        : '_Rispondi con un commento qui sotto: `sì` / `no` o testo libero. Il loop riprende da solo._',
      ...(verdict.attribution ? ['', `— asked by${attributionSuffix(verdict)}`] : []),
    ].join('\n');
    const commentId = commentWithId(config, pr, body);
    setLastVerdict(config.repo, pr, { sha, verdict });
    setDecision(config.repo, pr, { sha, question: q, askedAt: new Date().toISOString(), commentId });
    markReviewed(config.repo, pr, sha); // never re-verify this SHA while the question is pending
    setLabels([], [L.rework]); // NOT needsHuman: that label makes the tick skip the PR entirely
    await threadedPost(
      config,
      pr,
      `:question: PR #${pr} — decisione richiesta: ${firstLine(q.text)}\nhttps://github.com/${config.repo}/pull/${pr}#issuecomment-${commentId}${attributionSuffix(verdict)}`,
      { mention: true },
    );
    await setStateReaction(config, pr, 'decision');
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
    await threadedPost(config, pr, `:hourglass: PR #${pr} ok per il verifier ma tocca un path critico: serve la tua review${attributionSuffix(verdict)}`, {
      mention: true,
    });
    await setStateReaction(config, pr, 'needs_human');
    return;
  }

  try {
    approve(config, pr, verdictBody(verdict));
    mergeAuto(config, pr);
  } catch (error) {
    // Approved but couldn't auto-merge. A merge CONFLICT is agent-recoverable (rebase) — NOT a
    // human decision. needs-human is reserved for business/key calls (critical paths, dead agents).
    const ref = refForBranch(config.repo, branch);
    const mergeable = prMergeable(config, pr);
    if (mergeable === 'UNKNOWN') {
      // GitHub hasn't finished computing mergeability yet — transient, NOT a human decision (this was
      // the false needs-human on #119). Retry next tick: do NOT markReviewed (that freezes the SHA) and
      // do NOT escalate. Cost: one possible re-verify next tick; mergeability resolves in seconds.
      await threadedPost(config, pr, `:hourglass: PR #${pr} approvata, mergeability ancora in calcolo — merge al prossimo tick`);
      return;
    }
    if (ref && mergeable === 'CONFLICTING') {
      try {
        await getImplementer(config).followup(
          ref,
          `PR #${pr} approvata ma in conflitto con \`${config.base}\`. Fai \`git merge origin/${config.base}\`, risolvi i conflitti mantenendo la fedeltà, e pusha — il loop la re-reviewa e la mergia da sola.`,
        );
        setLabels([L.approved], [L.needsHuman, L.rework]);
        markReviewed(config.repo, pr, sha);
        await threadedPost(
          config,
          pr,
          `:twisted_rightwards_arrows: PR #${pr} approvata ma in conflitto con \`${config.base}\` — rebase automatico richiesto all'agent (nessun intervento umano)`,
        );
        await setStateReaction(config, pr, 'rework');
        return;
      } catch (followupErr) {
        // Busy/transient → retry next tick; permanent → fall through to needs-human below.
        if (followupErr instanceof FollowupError && (followupErr.kind === 'busy' || followupErr.kind === 'transient')) {
          return;
        }
      }
    }
    // Genuine escalation: no agent to rebase, or a non-conflict merge failure a human must judge.
    setLabels([L.approved, L.needsHuman], [L.rework]);
    markReviewed(config.repo, pr, sha);
    await threadedPost(
      config,
      pr,
      `:warning: PR #${pr} APPROVE ma merge fallito (${String(error)}) — serve un occhio`,
      { mention: true },
    );
    await setStateReaction(config, pr, 'needs_human');
    return;
  }
  setLabels([L.approved], [L.rework, L.needsHuman]);
  markReviewed(config.repo, pr, sha);
  clearLastVerdict(config.repo, pr); // review cycle closed — no re-review context to carry
  clearReworkRound(config.repo, pr);

  // If this PR closes a tracked issue, mark it completed. A merge into a non-default branch
  // does NOT auto-close the issue on GitHub, so this label signals "work done" until the
  // branch reaches main.
  const issue = issueForBranch(config.repo, branch);
  if (issue) {
    if (L.enabled) {
      addLabels(config, issue.issueNumber, [config.issues.completed]);
      removeLabels(config, issue.issueNumber, [config.issues.inProgress]);
    }
    markIssueDone(config.repo, issue.issueNumber);
  }

  await threadedPost(
    config,
    pr,
    `:white_check_mark: APPROVE PR #${pr} — auto-merge attivo${attributionSuffix(verdict)}` +
      `${issue ? ` (issue #${issue.issueNumber} → completed)` : ''}`,
  );
  await setStateReaction(config, pr, 'merged');
}
