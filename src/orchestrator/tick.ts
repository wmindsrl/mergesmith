// Stage-1 poll (cron entrypoint): cheap, provider-agnostic. For each agent-managed PR,
// gate on CI, then let the verifier judge (green) or send a fix follow-up (red).
import { existsSync } from 'node:fs';
import { heartbeatPath, loadConfig, pausedFlagPath, reposRegistryPath, type MergesmithConfig } from '../config.js';
import { readJson, writeJson } from '../lib.js';
import { addLabels, ciState, listOpenPRs } from '../github.js';
import { getImplementer, getVerifier } from '../providers/registry.js';
import { postSlack } from '../slack.js';
import { FollowupError, type ImplementerProvider } from '../providers/types.js';
import { knownBranches, loadReviewed, loadState, markReviewed, refForBranch, saveState } from './state.js';
import { applyVerdict } from './act.js';
import { runReadyIssues } from './issue.js';

export interface TickOptions {
  dryRun?: boolean;
  /** Local checkout dir of the target repo (multi-repo: passed to the verifier as cwd). */
  repoPath?: string;
}

export async function tickRepo(config: MergesmithConfig, opts: TickOptions = {}): Promise<void> {
  if (!opts.dryRun && existsSync(pausedFlagPath())) {
    console.log(`mergesmith in pausa (${pausedFlagPath()} presente) — skip`);
    return;
  }
  const impl = getImplementer(config);
  const verifier = getVerifier(config);
  const branches = new Set(knownBranches(config.repo));
  const reviewed = loadReviewed(config.repo);

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
    if (reviewed[String(pr.number)] === pr.headRefOid) continue;

    try {
      if (config.labels.enabled && !pr.labels.includes(config.labels.managed) && !opts.dryRun) {
        addLabels(config, pr.number, [config.labels.managed]);
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
      } else if (ci === 'red') {
        if (reviewed[String(pr.number)] === `${pr.headRefOid}:ci-red`) continue;
        await handleCiRed(config, impl, pr.number, pr.headRefName, pr.headRefOid);
      }
      // pending / error → skip, retry next tick
    } catch (error) {
      // One PR's failure (network hiccup, gh error) must never abort the whole batch.
      console.error(`✗ PR #${pr.number}: ${error instanceof Error ? error.message : String(error)} — continuo con le altre`);
    }
  }

  if (!opts.dryRun) {
    await reportStuckRuns(config, impl);
    writeJson(heartbeatPath(config.repo), { lastTick: new Date().toISOString() });
  }
}

async function handleCiRed(
  config: MergesmithConfig,
  impl: ImplementerProvider,
  pr: number,
  branch: string,
  sha: string,
): Promise<void> {
  if (config.labels.enabled) addLabels(config, pr, [config.labels.ciRed]);
  const ref = refForBranch(config.repo, branch);
  if (!ref) {
    // No implementer agent tracked → can't send the fix follow-up: flag for a human.
    if (config.labels.enabled) addLabels(config, pr, [config.labels.needsHuman]);
    await postSlack(config.slack, `:warning: PR #${pr}: CI rossa ma nessun agent noto per \`${branch}\` — fix manuale (flaggata needs-human)`, {
      mention: true,
    });
    markReviewed(config.repo, pr, `${sha}:ci-red`);
    return;
  }
  try {
    await impl.followup(ref, `CI is red on PR #${pr}. Check the failing jobs on GitHub, fix them and push.`);
    markReviewed(config.repo, pr, `${sha}:ci-red`);
  } catch (error) {
    if (error instanceof FollowupError && error.kind === 'busy') return; // retry next tick
    // Fallimento permanente (agent morto/expired): flagga + marca così NON si ri-notifica ogni tick.
    if (config.labels.enabled) addLabels(config, pr, [config.labels.needsHuman]);
    markReviewed(config.repo, pr, `${sha}:ci-red`);
    await postSlack(config.slack, `:warning: PR #${pr}: CI rossa e follow-up fallito (${String(error)}) — flaggata needs-human`, {
      mention: true,
    });
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
