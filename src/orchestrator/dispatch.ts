// `mergesmith dispatch <spec>`: send a Composer-ready spec to the implementer, which
// opens a PR. The return is handled by the tick (poll), not here.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadEnvVar, parseSpecFrontmatter } from '../lib.js';
import type { MergesmithConfig } from '../config.js';
import { createBranchWithSpec } from '../github.js';
import { getImplementer } from '../providers/registry.js';
import { postSlack } from '../slack.js';
import { loadState, saveState, setBranchThread } from './state.js';

export async function dispatchSpec(config: MergesmithConfig, specPath: string): Promise<void> {
  const markdown = readFileSync(specPath, 'utf8'); // throws with a clear ENOENT if missing
  const fm = parseSpecFrontmatter(markdown);
  if (fm.implementer !== 'composer') {
    throw new Error(`Spec "${fm.id}" ha implementer: ${fm.implementer} — dispatch è solo per implementer: composer`);
  }

  // Validate secrets BEFORE any side-effect (a successful dispatch with a failed notify
  // would look failed and invite a duplicate dispatch).
  loadEnvVar(config.implementer.apiKeyEnv);
  loadEnvVar(config.slack.botTokenEnv);

  // 0.5.0: mergesmith owns the branch. Commit the spec into a deterministic branch off base, then
  // dispatch the agent ONTO it (it opens the PR). No "spec must be on origin/base" precondition —
  // the spec rides in the branch. specSha is the stall-detection baseline (see sweepDispatchStalls).
  const specRepoPath = `docs/superpowers/specs/${basename(specPath)}`;
  const specSha = createBranchWithSpec(config, fm.branch, fm.base, specRepoPath, markdown);

  const impl = getImplementer(config);
  const prompt =
    `Read \`${specRepoPath}\` in THIS branch and implement it following \`${config.contract.appendix}\`. ` +
    `Work only within the spec's Scope and commit on THIS branch. Open a PR to \`${fm.base}\` using the ` +
    `CONTRACT PR template (the \`Spec:\` field is mandatory). When your self-check is fully green, mark the ` +
    `PR ready for review (NOT draft) — draft PRs are ignored by the review loop.`;
  const result = await impl.dispatch({
    prompt,
    repo: config.repo,
    base: fm.base,
    model: config.implementer.model,
    branch: fm.branch,
  });

  const state = loadState(config.repo);
  state.runs[fm.id] = {
    specId: fm.id,
    specPath,
    ref: result.ref,
    base: fm.base,
    branch: fm.branch,
    specSha,
    prUrl: result.prUrl ?? null,
    dispatchedAt: new Date().toISOString(),
  };
  saveState(config.repo, state);

  const branchInfo = `branch \`${fm.branch}\``;
  try {
    const engineLabel = config.implementer.model
      ? `${config.implementer.provider}/${config.implementer.model}`
      : config.implementer.provider;
    const res = await postSlack(
      config.slack,
      `:rocket: *Dispatch* — spec \`${fm.id}\` inviata a ${engineLabel} ` +
        `(base \`${fm.base}\`, ${branchInfo})${result.prUrl ? `\nPR: ${result.prUrl}` : ''}`,
    );
    // Make this the root of the PR's thread so verdicts/merge thread under a readable message.
    setBranchThread(config.repo, fm.branch, res.ts, res.channel);
  } catch (error) {
    // The dispatch DID succeed: don't fail (a retry would create a duplicate agent).
    console.error(`⚠ dispatch riuscito ma notifica Slack fallita: ${error}`);
  }
  console.log(`✓ dispatch "${fm.id}" — ${branchInfo}`);
}
