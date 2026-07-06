// Stage-1 poll (cron entrypoint): cheap, provider-agnostic. For each agent-managed PR,
// gate on CI, then let the verifier judge (green) or send a fix follow-up (red).
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { heartbeatPath, loadConfig, pausedFlagPath, reposRegistryPath, type MergesmithConfig } from '../config.js';
import { acquireRepoLock } from '../lock.js';
import { readJson, writeJson } from '../lib.js';
import { addLabels, branchHead, ciState, listOpenPRs, prStatesForBranch } from '../github.js';
import { getImplementer, getVerifier } from '../providers/registry.js';
import { postSlack } from '../slack.js';
import { adoptBranchThread, setStateReaction, threadedPost } from '../thread.js';
import { FollowupError, type ImplementerProvider } from '../providers/types.js';
import {
  bumpVerifyFail,
  clearRework,
  clearVerifyFail,
  getBranchThread,
  getRework,
  getThread,
  knownBranches,
  loadReviewed,
  loadState,
  markReviewed,
  refForBranch,
  saveState,
  setRefForBranch,
  setRework,
  setThread,
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

// Circuit breaker: max failed verify attempts on the same (pr, sha) before parking it for a human.
// A new push (new SHA) always re-arms the breaker.
const MAX_VERIFY_ATTEMPTS = 3;

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

async function runTickCycle(config: MergesmithConfig, opts: TickOptions): Promise<void> {
  const impl = getImplementer(config);
  const verifier = getVerifier(config);
  const branches = new Set(knownBranches(config.repo));
  const reviewed = loadReviewed(config.repo);

  // Slack inbox: !go-finalized threads → new `ready` issues (before runReadyIssues, so a freshly
  // created issue is dispatched in this same tick).
  if (!opts.dryRun) {
    try {
      await pollInbox(config);
    } catch (error) {
      console.error(`✗ inbox: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Mode B: dispatch any `ready` issues → they open cursor/* PRs handled by the loop below.
  if (!opts.dryRun) {
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
        const verdict = await verifier.verify({
          prNumber: pr.number,
          repo: config.repo,
          base: config.base,
          contractRef: config.contract.appendix,
          codeownersPath: config.criticalPaths,
          repoPath: opts.repoPath,
        });
        await applyVerdict(config, pr.number, pr.headRefOid, pr.headRefName, verdict);
        clearVerifyFail(config.repo, pr.number, pr.headRefOid);
      } else if (ci === 'red') {
        if (reviewed[String(pr.number)] === `${pr.headRefOid}:ci-red`) continue;
        await handleCiRed(config, impl, pr.number, pr.headRefName, pr.headRefOid);
      }
      // pending / error → skip, retry next tick
    } catch (error) {
      // One PR's failure (network hiccup, gh error) must never abort the whole batch.
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`✗ PR #${pr.number}: ${msg} — continuo con le altre`);
      // Circuit breaker: transient failures may retry on later ticks, but a persistently broken
      // verify (LLM/API down, bad checkout) must NOT re-run forever at tick frequency. After
      // MAX_VERIFY_ATTEMPTS on the same (pr, sha): park as verify-failed + flag a human.
      const attempts = bumpVerifyFail(config.repo, pr.number, pr.headRefOid);
      if (attempts >= MAX_VERIFY_ATTEMPTS && !opts.dryRun) {
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

  if (!opts.dryRun) {
    await sweepDispatchStalls(config, impl);
    await reportStuckRuns(config, impl);
    writeJson(heartbeatPath(config.repo), { lastTick: new Date().toISOString() });
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
    setRework(config.repo, pr, { ...rework, followupAt: Date.now(), attempts: rework.attempts + 1 });
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
