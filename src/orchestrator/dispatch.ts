// `mergesmith dispatch <spec>`: send a Composer-ready spec to the implementer, which
// opens a PR. The return is handled by the tick (poll), not here.
import { readFileSync } from 'node:fs';
import { loadEnvVar, parseSpecFrontmatter } from '../lib.js';
import type { MergesmithConfig } from '../config.js';
import { specExistsOnBase } from '../github.js';
import { getImplementer } from '../providers/registry.js';
import { postSlack } from '../slack.js';
import { loadState, saveState, setBranchThread } from './state.js';

export async function dispatchSpec(config: MergesmithConfig, specPath: string): Promise<void> {
  const markdown = readFileSync(specPath, 'utf8'); // throws with a clear ENOENT if missing
  const fm = parseSpecFrontmatter(markdown);
  if (fm.implementer !== 'composer') {
    throw new Error(`Spec "${fm.id}" ha implementer: ${fm.implementer} — dispatch è solo per implementer: composer`);
  }

  // Precondition: the spec must exist on origin/<base> (the cloud agent reads the repo, not local FS).
  if (!specExistsOnBase(config, specPath, fm.base)) {
    throw new Error(`La spec non esiste su origin/${fm.base}: committala e pushala su ${fm.base} prima del dispatch`);
  }

  // Validate secrets BEFORE any side-effect (a successful dispatch with a failed notify
  // would look failed and invite a duplicate dispatch).
  loadEnvVar(config.implementer.apiKeyEnv);
  loadEnvVar(config.slack.botTokenEnv);

  const impl = getImplementer(config);
  const prompt =
    `Read \`${specPath}\` and implement it following \`${config.contract.appendix}\`. ` +
    `Work only within the spec's Scope. Open a PR to \`${fm.base}\` using the CONTRACT PR template ` +
    `(the \`Spec:\` field is mandatory). When your self-check is fully green, mark the PR ready ` +
    `for review (NOT draft) — draft PRs are ignored by the review loop.`;
  const result = await impl.dispatch({ prompt, repo: config.repo, base: fm.base, model: config.implementer.model });

  const state = loadState(config.repo);
  state.runs[fm.id] = {
    specId: fm.id,
    specPath,
    ref: result.ref,
    base: fm.base,
    branch: result.branch ?? null,
    prUrl: result.prUrl ?? null,
    dispatchedAt: new Date().toISOString(),
  };
  saveState(config.repo, state);

  const branchInfo = result.branch ? `branch \`${result.branch}\`` : 'branch non ancora creato (comparirà nella PR)';
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
    if (result.branch) setBranchThread(config.repo, result.branch, res.ts, res.channel);
  } catch (error) {
    // The dispatch DID succeed: don't fail (a retry would create a duplicate agent).
    console.error(`⚠ dispatch riuscito ma notifica Slack fallita: ${error}`);
  }
  console.log(`✓ dispatch "${fm.id}" — ${branchInfo}`);
}
