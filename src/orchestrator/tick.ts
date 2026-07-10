// Stage-1 poll (cron entrypoint): cheap, provider-agnostic. For each agent-managed PR,
// gate on CI, then let the verifier judge (green) or send a fix follow-up (red).
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { heartbeatPath, loadConfig, pausedFlagPath, reposRegistryPath, type MergesmithConfig } from '../config.js';
import { acquireRepoLock } from '../lock.js';
import { readJson, writeJson } from '../lib.js';
import { addLabels, authorHasWriteAccess, botLogin, branchHead, ciState, commentsSince, listOpenPRs, prStatesForBranch, type OpenPR, type PrComment } from '../github.js';
import { getImplementer, getVerifier } from '../providers/registry.js';
import { postSlack } from '../slack.js';
import { adoptBranchThread, setStateReaction, threadedPost } from '../thread.js';
import { FollowupError, type ImplementerProvider, type VerifierProvider } from '../providers/types.js';
import {
  bumpVerifyFail,
  clearDecision,
  clearRework,
  clearVerifyFail,
  getBranchThread,
  getDecision,
  getLastVerdict,
  getRework,
  getThread,
  knownBranches,
  loadReviewed,
  loadState,
  markReviewed,
  refForBranch,
  saveState,
  appendSettledDecision,
  setRefForBranch,
  setRework,
  setThread,
  unmarkReviewed,
  type DecisionRecord,
  type ReworkRecord,
} from './state.js';
import { applyVerdict } from './act.js';
import { runReadyIssues } from './issue.js';
import { pollInbox } from '../inbox.js';

export interface TickOptions {
  dryRun?: boolean;
  /** Local checkout dir of the target repo (multi-repo: passed to the verifier as cwd). */
  repoPath?: string;
}

export interface ScanOptions extends TickOptions {
  /** Skip Slack-inbox + ready-issue intake this pass (the watch loop throttles intake). */
  skipIntake?: boolean;
}

// Circuit breaker: max failed verify attempts on the same (pr, sha) before parking it for a human.
// A new push (new SHA) always re-arms the breaker.
const MAX_VERIFY_ATTEMPTS = 3;

// Concurrent LLM verifies. Reviews are read-only on the shared checkout and write per-PR
// verdict files, so they parallelize safely; 3 keeps memory/API pressure sane.
export const MAX_CONCURRENT_VERIFY = 3;

export async function tickRepo(config: MergesmithConfig, opts: TickOptions = {}): Promise<void> {
  if (!opts.dryRun && existsSync(pausedFlagPath())) {
    console.log(`mergesmith in pausa (${pausedFlagPath()} presente) — skip`);
    return;
  }
  if (opts.dryRun) {
    await runTickCycle(config, opts);
    return;
  }
  // CLI-level lock: no two concurrent tick/verify runs on the same repo (verdict-file / state race).
  const release = acquireRepoLock(config.repo);
  if (!release) {
    console.log(`tick ${config.repo}: già in corso (lock), skip`);
    return;
  }
  try {
    await runTickCycle(config, opts);
  } finally {
    release();
  }
}

/**
 * One pass over the repo: intake + per-PR gates (decision, rework watchdog, CI). Green,
 * not-yet-reviewed PRs are handed to `enqueueVerify` — the CALLER owns how verifies run
 * (tick: bounded batch awaited in-cycle; watch: persistent pool that survives across scans).
 */
export async function scanRepo(
  config: MergesmithConfig,
  opts: ScanOptions,
  enqueueVerify: (pr: OpenPR) => void,
): Promise<void> {
  const impl = getImplementer(config);
  const branches = new Set(knownBranches(config.repo));
  const reviewed = loadReviewed(config.repo);

  // Slack inbox: !go-finalized threads → new `ready` issues (before runReadyIssues, so a freshly
  // created issue is dispatched in this same pass).
  if (!opts.dryRun && !opts.skipIntake) {
    try {
      await pollInbox(config);
    } catch (error) {
      console.error(`✗ inbox: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Mode B: dispatch any `ready` issues → they open cursor/* PRs handled by the loop below.
    try {
      await runReadyIssues(config);
    } catch (error) {
      console.error(`✗ ready-issues: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const pr of listOpenPRs(config)) {
    if (pr.isDraft) continue;
    const managed = pr.headRefName.startsWith(impl.branchPrefix) || branches.has(pr.headRefName);
    if (!managed) continue;
    // needs-human = l'umano possiede questa PR: il loop si tira indietro (niente ri-review /
    // ri-ping a ogni push finché la label non viene rimossa).
    if (config.labels.enabled && pr.labels.includes(config.labels.needsHuman)) continue;

    // NEEDS_DECISION parked: poll for the owner's answer to the question comment. Answer found →
    // unmark the SHA and fall through, so THIS same tick re-verifies with the answer as binding
    // context. No answer → the PR stays parked (no verify, no follow-up).
    if (!opts.dryRun) {
      const decision = getDecision(config.repo, pr.number);
      if (decision) {
        if (pr.headRefOid !== decision.sha) {
          // New push while the question was pending: before reviewing the new SHA, sweep for an
          // answer that may have landed together with the push — otherwise it would be silently
          // lost and the verifier would re-ask the same question.
          try {
            const answer = readDecisionAnswer(config, pr.number, decision);
            if (answer) {
              await threadedPost(config, pr.number, `:arrow_right: PR #${pr.number}: risposta di @${answer.author} registrata — "${answerExcerpt(answer.body)}"`);
            }
          } catch (error) {
            console.error(`✗ decision-sweep PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
          }
          clearDecision(config.repo, pr.number); // no-op if readDecisionAnswer already cleared it
        } else {
          try {
            const answered = await checkDecisionAnswer(config, pr.number, decision);
            if (!answered) continue; // still waiting for the owner
            // Keep the in-memory copy in sync with unmarkReviewed, so the re-verify happens NOW.
            delete reviewed[String(pr.number)];
          } catch (error) {
            console.error(`✗ decision PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
        }
      }
    }

    // Rework watchdog: a REQUEST_CHANGES follow-up must produce a new SHA. If it did, the agent
    // delivered → re-review. If not and the agent has stalled (closed its run without pushing, or
    // TTL elapsed), auto-recover with a fresh agent; after MAX_RECOVER attempts → needs-human.
    if (!opts.dryRun) {
      const rework = getRework(config.repo, pr.number);
      if (rework) {
        if (pr.headRefOid !== rework.sha) {
          clearRework(config.repo, pr.number); // delivered → fall through to a fresh review
        } else {
          try {
            await handleReworkStall(config, impl, pr.number, pr.headRefName, rework);
          } catch (error) {
            console.error(`✗ rework-watchdog PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
          }
          continue; // same SHA → don't re-review; wait / recovered / escalated
        }
      }
    }

    if (reviewed[String(pr.number)] === pr.headRefOid) continue;
    // Circuit breaker: this (pr, sha) already burned MAX_VERIFY_ATTEMPTS — parked for a human,
    // don't re-run a broken verify forever (see catch below).
    if (reviewed[String(pr.number)] === `${pr.headRefOid}:verify-failed`) continue;

    try {
      if (config.labels.enabled && !pr.labels.includes(config.labels.managed) && !opts.dryRun) {
        addLabels(config, pr.number, [config.labels.managed]);
      }

      // First time we see this PR: adopt its dispatch message as the thread root, so the whole
      // lifecycle threads under the readable ":rocket: Dispatch" message in the channel.
      if (!opts.dryRun && !getThread(config.repo, pr.number)) {
        const bt = getBranchThread(config.repo, pr.headRefName);
        if (bt) setThread(config.repo, pr.number, bt.ts, bt.channel);
      }

      const ci = ciState(config, pr.headRefOid);
      if (opts.dryRun) {
        console.log(`DRY: PR #${pr.number} (${pr.headRefName}) ci=${ci}`);
        continue;
      }

      if (ci === 'green') {
        // Hand off to the caller's verify pool — verifies are the slow LLM stage and
        // must not serialize the whole queue (one PR at a time was the old bottleneck).
        enqueueVerify(pr);
      } else if (ci === 'red') {
        if (reviewed[String(pr.number)] === `${pr.headRefOid}:ci-red`) continue;
        await handleCiRed(config, impl, pr.number, pr.headRefName, pr.headRefOid);
      }
      // pending / error → skip, retry next tick
    } catch (error) {
      // One PR's failure (network hiccup, gh error) must never abort the whole batch.
      // (Verify failures + circuit breaker are handled inside the pool.)
      console.error(`✗ PR #${pr.number}: ${error instanceof Error ? error.message : String(error)} — continuo con le altre`);
    }
  }
}

/** Verify one PR and apply its verdict. Never throws: failures feed the circuit breaker
 * (MAX_VERIFY_ATTEMPTS on the same sha → park + flag a human). Shared by tick and watch. */
export async function verifyAndApply(
  config: MergesmithConfig,
  opts: TickOptions,
  verifier: VerifierProvider,
  pr: OpenPR,
): Promise<void> {
  try {
    // Previous verdict (if any) → RE-REVIEW: scoped to previous blockers + delta, on the
    // faster reworkModel; the owner's settled decisions ride along as binding.
    const rereview = getLastVerdict(config.repo, pr.number) ?? undefined;
    const verdict = await verifier.verify({
      prNumber: pr.number,
      repo: config.repo,
      base: config.base,
      contractRef: config.contract.appendix,
      codeownersPath: config.criticalPaths,
      repoPath: opts.repoPath,
      rereview,
    });
    await applyVerdict(config, pr.number, pr.headRefOid, pr.headRefName, verdict);
    clearVerifyFail(config.repo, pr.number, pr.headRefOid);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`✗ verify PR #${pr.number}: ${msg} — continuo con le altre`);
    // Circuit breaker: transient failures may retry on later passes, but a persistently
    // broken verify (LLM/API down, bad checkout) must NOT re-run forever. After
    // MAX_VERIFY_ATTEMPTS on the same (pr, sha): park + flag a human.
    const attempts = bumpVerifyFail(config.repo, pr.number, pr.headRefOid);
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      markReviewed(config.repo, pr.number, `${pr.headRefOid}:verify-failed`);
      if (config.labels.enabled) addLabels(config, pr.number, [config.labels.needsHuman]);
      await threadedPost(
        config,
        pr.number,
        `:warning: PR #${pr.number}: verifica fallita ${attempts} volte sullo stesso SHA (${msg}) — parcheggiata, serve un occhio (un nuovo push la riattiva)`,
        { mention: true, branch: pr.headRefName },
      );
      await setStateReaction(config, pr.number, 'needs_human');
    }
  }
}

/** Stall sweeps + heartbeat (shared by tick and watch — the watch throttles the sweeps). */
export async function sweepAndHeartbeat(config: MergesmithConfig, sweep: boolean): Promise<void> {
  if (sweep) {
    const impl = getImplementer(config);
    await sweepDispatchStalls(config, impl);
    await reportStuckRuns(config, impl);
  }
  writeJson(heartbeatPath(config.repo), { lastTick: new Date().toISOString() });
}

async function runTickCycle(config: MergesmithConfig, opts: TickOptions): Promise<void> {
  // PRs whose CI is green and SHA not yet reviewed — verified concurrently after the scan.
  const toVerify: OpenPR[] = [];
  await scanRepo(config, opts, (pr) => toVerify.push(pr));

  // Concurrent verify pool: the LLM review is the slow stage (minutes per PR); run up to
  // MAX_CONCURRENT_VERIFY at once instead of serializing the whole queue. Safe because the
  // review command is read-only on the shared checkout (gh api + git fetch/show) and each
  // session writes a PER-PR verdict file.
  if (!opts.dryRun && toVerify.length > 0) {
    console.log(`verify pool: ${toVerify.length} PR in coda, concorrenza ${Math.min(MAX_CONCURRENT_VERIFY, toVerify.length)}`);
    const verifier = getVerifier(config);
    const queue = [...toVerify];
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_VERIFY, queue.length) }, async () => {
      for (let pr = queue.shift(); pr !== undefined; pr = queue.shift()) {
        await verifyAndApply(config, opts, verifier, pr);
      }
    });
    await Promise.all(workers);
  }

  if (!opts.dryRun) {
    await sweepAndHeartbeat(config, true);
  }
}

const DISPATCH_GRACE_MS = 5 * 60 * 1000; // give a fresh dispatch time to start + work before judging
const MAX_DISPATCH_RECOVER = 2;

// --- pure decision core (unit-tested; the I/O wrapper below feeds it live values) ---

/** What the branch's PR history says about a dispatched run. */
export function prGateAction(prStates: string[]): 'none' | 'open' | 'merged' {
  if (prStates.length === 0) return 'none'; // agent never opened a PR → stall candidate
  return prStates.every((s) => s !== 'OPEN') ? 'merged' : 'open';
}

/** Given a finished run with NO PR: did it deliver, and what should we do about it? */
export function noOpRecovery(
  head: string | null,
  specSha: string,
  attempts: number,
  max: number,
): 'gone' | 'giveup' | 'nudge' | 'recover' {
  if (head === null) return 'gone'; // mergesmith-created branch vanished without a PR — anomalous
  if (attempts >= max) return 'giveup';
  return head !== specSha ? 'nudge' : 'recover'; // committed-but-no-PR vs pure no-op
}

// 0.5.0: initial-dispatch stall sweep. A run whose branch mergesmith pre-created (specSha set) but that
// never opened a PR is invisible to the per-PR loop. This catches the exact overnight failure (agent
// finished without delivering): run FINISHED + branchHead === specSha ⇒ no-op → auto-recover; committed
// but no PR ⇒ nudge to open it; both bounded by recoverAttempts, then needs-human.
async function sweepDispatchStalls(config: MergesmithConfig, impl: ImplementerProvider): Promise<void> {
  const state = loadState(config.repo);
  const openBranches = new Set(listOpenPRs(config).map((p) => p.headRefName));
  let changed = false;

  for (const [id, rec] of Object.entries(state.runs)) {
    if (rec.done || !rec.branch || !rec.specSha || !rec.ref?.agentId) continue; // legacy runs have no specSha
    if (openBranches.has(rec.branch)) continue; // PR open → per-PR loop / rework watchdog owns it
    if (Date.now() - new Date(rec.dispatchedAt).getTime() < DISPATCH_GRACE_MS) continue;

    const gate = prGateAction(prStatesForBranch(config, rec.branch));
    if (gate === 'open') continue; // race with openBranches → per-PR loop owns it
    if (gate === 'merged') {
      rec.done = true; // the run's PR merged/closed → nothing left to sweep
      changed = true;
      continue;
    }

    let idle = false;
    try {
      idle = impl.agentIdle ? await impl.agentIdle(rec.ref) : false;
    } catch {
      continue; // status unreadable → try next tick
    }
    if (!idle) continue; // still working

    const attempts = rec.recoverAttempts ?? 0;
    const action = noOpRecovery(branchHead(config, rec.branch), rec.specSha, attempts, MAX_DISPATCH_RECOVER);
    try {
      if (action === 'gone') {
        rec.done = true;
        changed = true;
        await postSlack(config.slack, `:warning: dispatch \`${id}\`: branch \`${rec.branch}\` sparito senza PR — serve un occhio`, { mention: true });
      } else if (action === 'giveup') {
        rec.done = true;
        changed = true;
        await postSlack(config.slack, `:warning: dispatch \`${id}\` (\`${rec.branch}\`) fermo dopo ${attempts} recovery — l'agent non consegna, serve la tua mano`, { mention: true });
      } else if (action === 'nudge') {
        // Work is on the branch, only the PR is missing → nudge the same agent to open it.
        await impl.followup(rec.ref, `You committed to \`${rec.branch}\` but no PR is open. Open a PR to \`${rec.base}\` (ready for review, NOT draft).`);
        rec.recoverAttempts = attempts + 1;
        changed = true;
        await postSlack(config.slack, `:arrows_counterclockwise: dispatch \`${id}\`: codice sul branch ma niente PR — sollecito apertura (${attempts + 1}/${MAX_DISPATCH_RECOVER})`);
      } else if (action === 'recover' && impl.adoptBranch) {
        // Pure no-op (branchHead === specSha) → spawn a fresh agent on the same branch to redo it.
        const res = await impl.adoptBranch(
          config.repo,
          rec.branch,
          `Re-read \`docs/superpowers/specs/${basename(rec.specPath)}\` in this branch and implement it — the previous run finished without committing any code. Commit on THIS branch and open a PR to \`${rec.base}\`.`,
        );
        rec.ref = res.ref;
        rec.recoverAttempts = attempts + 1;
        changed = true;
        await postSlack(config.slack, `:recycle: dispatch \`${id}\` no-op (agent finito senza consegnare) — re-dispatch su \`${rec.branch}\` (${attempts + 1}/${MAX_DISPATCH_RECOVER})`);
      }
    } catch (error) {
      if (error instanceof FollowupError && (error.kind === 'busy' || error.kind === 'transient')) continue; // retry next tick
      console.error(`✗ sweepDispatchStalls ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (changed) saveState(config.repo, state);
}

/** First comment after the question written by an AUTHORIZED author: the owner's answer.
 * Pure (unit-tested). Authorization is FAIL-CLOSED via `isAuthorized` (repo write/admin): a
 * drive-by account or third-party bot commenting on the PR must never decide for the owner. */
export function pickAnswer(
  comments: PrComment[],
  questionCommentId: number,
  bot: string | null,
  isAuthorized: (login: string) => boolean,
): PrComment | null {
  return (
    comments.find((c) => c.id > questionCommentId && (bot === null || c.author !== bot) && isAuthorized(c.author)) ?? null
  );
}

/** Answer excerpt for Slack (markup is escaped downstream by buildSlackText). */
function answerExcerpt(body: string): string {
  return (body.split('\n')[0] ?? '').slice(0, 120);
}

// Read the owner's reply to a NEEDS_DECISION question, if it landed. Found → record it as a
// SETTLED decision (carried across all later rounds). Returns the answering comment or null.
function readDecisionAnswer(config: MergesmithConfig, pr: number, decision: DecisionRecord): PrComment | null {
  const comments = commentsSince(config, pr, decision.askedAt);
  const answer = pickAnswer(comments, decision.commentId, botLogin(config), (login) => authorHasWriteAccess(config, login));
  if (!answer) return null;
  appendSettledDecision(config.repo, pr, decision.question.text, answer.body);
  clearDecision(config.repo, pr);
  return answer;
}

// Poll for the owner's reply and unpark the PR (caller re-verifies in the same tick).
async function checkDecisionAnswer(config: MergesmithConfig, pr: number, decision: DecisionRecord): Promise<boolean> {
  const answer = readDecisionAnswer(config, pr, decision);
  if (!answer) return false;
  unmarkReviewed(config.repo, pr);
  await threadedPost(config, pr, `:arrow_right: PR #${pr}: risposta di @${answer.author} — "${answerExcerpt(answer.body)}" — ri-verifico subito`);
  await setStateReaction(config, pr, 'rework');
  return true;
}

const REWORK_GRACE_MS = 5 * 60 * 1000; // don't judge a follow-up before its run has a chance to start
const REWORK_STALL_TTL_MS = 25 * 60 * 1000; // hard fallback when the agent's run state is unreadable
const MAX_RECOVER = 2;

// A rework whose SHA hasn't moved: decide wait / auto-recover / escalate.
async function handleReworkStall(
  config: MergesmithConfig,
  impl: ImplementerProvider,
  pr: number,
  branch: string,
  rework: ReworkRecord,
): Promise<void> {
  adoptBranchThread(config, pr, branch);

  // Verdict applied but the follow-up never reached the agent (busy/transient at verdict time,
  // issue #1): retry ONLY the delivery — the review is already on GitHub; re-verifying would
  // duplicate it. On failure fall through: the stall logic below bounds the wait (TTL/idle →
  // adoptBranch, which hands the SAME fixPrompt to a fresh agent).
  if (rework.delivered === false) {
    const ref = refForBranch(config.repo, branch);
    if (ref) {
      try {
        await impl.followup(ref, rework.fixPrompt);
        setRework(config.repo, pr, { ...rework, followupAt: Date.now(), delivered: true });
        await threadedPost(config, pr, `:arrow_right: PR #${pr}: follow-up consegnato all'agent — rework in corso`);
        return;
      } catch (error) {
        console.error(`✗ delivery follow-up PR #${pr}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const elapsed = Date.now() - rework.followupAt;
  if (elapsed < REWORK_GRACE_MS) return; // give the follow-up run time to start + work

  const ref = refForBranch(config.repo, branch);
  let stalled = elapsed > REWORK_STALL_TTL_MS;
  if (!stalled && ref && impl.agentIdle) {
    // Agent's latest run finished but no new SHA landed → it closed without pushing = stalled.
    stalled = await impl.agentIdle(ref);
  }
  if (!stalled) return; // still working — wait for the next tick

  if (rework.attempts < MAX_RECOVER && impl.adoptBranch) {
    const res = await impl.adoptBranch(config.repo, branch, rework.fixPrompt);
    setRefForBranch(config.repo, branch, res.ref);
    // delivered: the fresh agent received fixPrompt at spawn — don't re-send it next tick.
    setRework(config.repo, pr, { ...rework, followupAt: Date.now(), attempts: rework.attempts + 1, delivered: true });
    await threadedPost(
      config,
      pr,
      `:recycle: PR #${pr}: rework fermo (l'agent ha chiuso senza pushare) — riparto con un agent fresco sul branch (tentativo ${rework.attempts + 1}/${MAX_RECOVER})`,
    );
    await setStateReaction(config, pr, 'rework');
    return;
  }

  // Recovery exhausted (or no adoptBranch) → a genuine human call: the implementer won't self-fix.
  clearRework(config.repo, pr);
  if (config.labels.enabled) addLabels(config, pr, [config.labels.needsHuman]);
  await threadedPost(
    config,
    pr,
    `:warning: PR #${pr}: rework fermo dopo ${rework.attempts} tentativi di auto-recover — l'implementer non applica il fix, serve la tua mano`,
    { mention: true },
  );
  await setStateReaction(config, pr, 'needs_human');
}

async function handleCiRed(
  config: MergesmithConfig,
  impl: ImplementerProvider,
  pr: number,
  branch: string,
  sha: string,
): Promise<void> {
  adoptBranchThread(config, pr, branch);
  if (config.labels.enabled) addLabels(config, pr, [config.labels.ciRed]);
  const ref = refForBranch(config.repo, branch);
  if (!ref) {
    // No implementer agent tracked → can't send the fix follow-up: flag for a human.
    if (config.labels.enabled) addLabels(config, pr, [config.labels.needsHuman]);
    await threadedPost(config, pr, `:warning: PR #${pr}: CI rossa ma nessun agent noto per \`${branch}\` — fix manuale (flaggata needs-human)`, {
      mention: true,
    });
    markReviewed(config.repo, pr, `${sha}:ci-red`);
    await setStateReaction(config, pr, 'needs_human');
    return;
  }
  try {
    await impl.followup(ref, `CI is red on PR #${pr}. Check the failing jobs on GitHub, fix them and push.`);
    markReviewed(config.repo, pr, `${sha}:ci-red`);
    await setStateReaction(config, pr, 'ci_red');
  } catch (error) {
    if (error instanceof FollowupError && (error.kind === 'busy' || error.kind === 'transient')) return; // retry next tick
    // Fallimento permanente (agent morto/expired): flagga + marca così NON si ri-notifica ogni tick.
    if (config.labels.enabled) addLabels(config, pr, [config.labels.needsHuman]);
    markReviewed(config.repo, pr, `${sha}:ci-red`);
    await threadedPost(config, pr, `:warning: PR #${pr}: CI rossa e follow-up fallito (${String(error)}) — flaggata needs-human`, {
      mention: true,
    });
    await setStateReaction(config, pr, 'needs_human');
  }
}

async function reportStuckRuns(config: MergesmithConfig, impl: ImplementerProvider): Promise<void> {
  const state = loadState(config.repo);
  let changed = false;
  for (const rec of Object.values(state.runs)) {
    if (rec.done || !rec.ref?.agentId || !rec.ref?.runId) continue;
    try {
      const status = await impl.status(rec.ref);
      if (status.state === 'error' || status.state === 'expired') {
        await postSlack(config.slack, `:x: Run per spec \`${rec.specId}\` in stato ${status.state} — serve un occhio`);
        rec.done = true;
        changed = true;
      } else if (status.state === 'finished') {
        rec.done = true;
        changed = true;
      }
    } catch (error) {
      console.error(`status ${rec.specId}: ${error}`);
    }
  }
  if (changed) saveState(config.repo, state);
}

export async function tickAll(opts: TickOptions = {}): Promise<void> {
  const registryPath = reposRegistryPath();
  const registry = readJson<{ repos: Array<{ path: string }> }>(registryPath, { repos: [] });
  if (registry.repos.length === 0) {
    console.warn(`Nessun repo registrato in ${registryPath}. Aggiungi { "repos": [{ "path": "/path/al/repo" }] }`);
    return;
  }
  for (const entry of registry.repos) {
    try {
      await tickRepo(loadConfig(entry.path), { ...opts, repoPath: entry.path });
    } catch (error) {
      console.error(`tick ${entry.path}: ${error}`);
    }
  }
}
