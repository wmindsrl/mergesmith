// Issues as work-source. Mode A: `mergesmith dispatch --issue <n>` (manual).
// Mode B: the tick dispatches every open issue labelled `mergesmith:ready`.
// The resulting PR (Closes #N) flows through the normal review loop; merging closes the issue.
import { loadEnvVar } from '../lib.js';
import type { MergesmithConfig } from '../config.js';
import { addLabels, getIssue, listOpenIssuesWithLabel, removeLabels, type IssueMeta } from '../github.js';
import { getImplementer } from '../providers/registry.js';
import { postSlack } from '../slack.js';
import { issueDispatched, recordIssue, setBranchThread } from './state.js';

function issuePrompt(config: MergesmithConfig, issue: IssueMeta, base: string): string {
  return (
    `Implement GitHub issue #${issue.number}: "${issue.title}".\n\n` +
    `${issue.body}\n\n` +
    `Follow \`${config.contract.appendix}\`. Work only within the issue's scope. ` +
    `Open a PR to \`${base}\` whose description includes "Closes #${issue.number}" and follows ` +
    `the CONTRACT PR template. When your self-check is fully green, mark the PR ready (NOT draft).`
  );
}

export async function dispatchIssue(config: MergesmithConfig, issueNumber: number, baseOverride?: string): Promise<void> {
  const issue = getIssue(config, issueNumber);
  const base = baseOverride ?? config.base;

  // Validate secrets before side-effects (a successful dispatch with a failed notify would
  // look failed and invite a duplicate dispatch).
  loadEnvVar(config.implementer.apiKeyEnv);
  loadEnvVar(config.slack.botTokenEnv);

  const impl = getImplementer(config);
  const result = await impl.dispatch({
    prompt: issuePrompt(config, issue, base),
    repo: config.repo,
    base,
    model: config.implementer.model,
  });

  recordIssue(config.repo, {
    issueNumber,
    ref: result.ref,
    branch: result.branch ?? null,
    prUrl: result.prUrl ?? null,
    dispatchedAt: new Date().toISOString(),
  });
  addLabels(config, issueNumber, [config.issues.inProgress]);
  removeLabels(config, issueNumber, [config.issues.ready]);

  const engineLabel = config.implementer.model
    ? `${config.implementer.provider}/${config.implementer.model}`
    : config.implementer.provider;
  const branchInfo = result.branch ? `branch \`${result.branch}\`` : 'branch in arrivo';
  try {
    const res = await postSlack(
      config.slack,
      `:rocket: *Dispatch issue #${issueNumber}* — "${issue.title}" → ${engineLabel} (${branchInfo})` +
        `${result.prUrl ? `\nPR: ${result.prUrl}` : ''}`,
    );
    // Make this the root of the PR's thread so verdicts/merge thread under a readable message.
    if (result.branch) setBranchThread(config.repo, result.branch, res.ts, res.channel);
  } catch (error) {
    console.error(`⚠ dispatch issue riuscito ma notifica Slack fallita: ${error}`);
  }
  console.log(`✓ dispatch issue #${issueNumber} — ${branchInfo}`);
}

// Mode B: dispatch every open `ready` issue not already dispatched. Per-issue try/catch so one
// bad issue doesn't abort the batch.
export async function runReadyIssues(config: MergesmithConfig): Promise<void> {
  for (const n of listOpenIssuesWithLabel(config, config.issues.ready)) {
    if (issueDispatched(config.repo, n)) continue;
    try {
      await dispatchIssue(config, n);
    } catch (error) {
      console.error(`✗ dispatch issue #${n}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
