// Thin wrapper around the `gh` CLI, always scoped to config.repo and authenticated
// with the configured automation token (Write, no bypass). Includes the PR-label helpers.
import { execFileSync } from 'node:child_process';
import { loadEnvVar } from './lib.js';
import type { MergesmithConfig } from './config.js';

export interface OpenPR {
  number: number;
  headRefOid: string;
  headRefName: string;
  isDraft: boolean;
  labels: string[];
}

export type CiState = 'green' | 'pending' | 'red' | 'error';

function ghEnv(config: MergesmithConfig): NodeJS.ProcessEnv {
  return { ...process.env, GH_TOKEN: loadEnvVar(config.github.tokenEnv) };
}

function run(config: MergesmithConfig, args: string[], input?: string): string {
  return execFileSync('gh', args, {
    env: ghEnv(config),
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

// For calls where a non-zero exit is a normal signal (missing content, best-effort label ops).
function tryRun(config: MergesmithConfig, args: string[]): string | null {
  try {
    return run(config, args);
  } catch {
    return null;
  }
}

export function listOpenPRs(config: MergesmithConfig): OpenPR[] {
  const out = run(config, [
    'pr', 'list', '--repo', config.repo, '--state', 'open',
    '--json', 'number,headRefOid,headRefName,isDraft,labels',
  ]);
  const raw = JSON.parse(out) as Array<{
    number: number;
    headRefOid: string;
    headRefName: string;
    isDraft: boolean;
    labels: Array<{ name: string }>;
  }>;
  return raw.map((p) => ({
    number: p.number,
    headRefOid: p.headRefOid,
    headRefName: p.headRefName,
    isDraft: p.isDraft,
    labels: p.labels.map((l) => l.name),
  }));
}

// CI status via Actions API (gh run list) — needs only Actions:Read on the token,
// unlike `gh pr checks` which needs the Checks permission.
export function ciState(config: MergesmithConfig, sha: string): CiState {
  const out = tryRun(config, [
    'run', 'list', '--repo', config.repo, '--commit', sha,
    '--workflow', config.ci.workflowName, '--limit', '1', '--json', 'status,conclusion',
  ]);
  if (out === null) return 'error';
  const runs = JSON.parse(out) as Array<{ status: string; conclusion: string | null }>;
  if (runs.length === 0) return 'pending';
  const first = runs[0]!;
  if (first.status !== 'completed') return 'pending';
  return first.conclusion === 'success' ? 'green' : 'red';
}

export function specExistsOnBase(config: MergesmithConfig, specPath: string, base: string): boolean {
  const out = tryRun(config, ['api', `repos/${config.repo}/contents/${specPath}?ref=${base}`, '--jq', '.path']);
  return out !== null && out.length > 0;
}

// --- 0.5.0: mergesmith-owned branch (spec committed inside) ---

/** True if `branch` exists on the remote. */
export function branchExists(config: MergesmithConfig, branch: string): boolean {
  const out = tryRun(config, ['api', `repos/${config.repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']);
  return out !== null && out.length > 0;
}

/** Current tip SHA of `branch`, or null if the branch is gone (agent stall vs work delivered). */
export function branchHead(config: MergesmithConfig, branch: string): string | null {
  const out = tryRun(config, ['api', `repos/${config.repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']);
  return out && out.length > 0 ? out : null;
}

/** PR states (any status) whose head is `branch`. Empty ⇒ the agent never opened a PR (stall candidate);
 * non-empty all-non-OPEN ⇒ the run's PR merged/closed (the run is finished). */
export function prStatesForBranch(config: MergesmithConfig, branch: string): string[] {
  const out = tryRun(config, [
    'pr', 'list', '--repo', config.repo, '--head', branch, '--state', 'all', '--json', 'state', '--jq', '.[].state',
  ]);
  return out ? out.split('\n').filter((s) => s.length > 0) : [];
}

/**
 * Create (or force-reset, on re-dispatch) `branch` off `base` with `specContent` committed at
 * `specPath`. Returns the commit SHA — the *specSha*, the stall-detection baseline: after the run
 * finishes, branchHead === specSha means the agent delivered nothing. Pure GitHub Data API: works
 * from any cwd, no local checkout, no "spec must already be on origin/base" precondition.
 */
export function createBranchWithSpec(
  config: MergesmithConfig,
  branch: string,
  base: string,
  specPath: string,
  specContent: string,
): string {
  const repo = config.repo;
  const apiPost = (endpoint: string, body: unknown): string =>
    run(config, ['api', `repos/${repo}/${endpoint}`, '--method', 'POST', '--input', '-', '--jq', '.sha'], JSON.stringify(body));

  const baseCommitSha = run(config, ['api', `repos/${repo}/git/ref/heads/${base}`, '--jq', '.object.sha']);
  const baseTreeSha = run(config, ['api', `repos/${repo}/git/commits/${baseCommitSha}`, '--jq', '.tree.sha']);
  const blobSha = apiPost('git/blobs', { content: specContent, encoding: 'utf-8' });
  const treeSha = apiPost('git/trees', {
    base_tree: baseTreeSha,
    tree: [{ path: specPath, mode: '100644', type: 'blob', sha: blobSha }],
  });
  const commitSha = apiPost('git/commits', {
    message: `spec: ${specPath}`,
    tree: treeSha,
    parents: [baseCommitSha],
  });
  if (branchExists(config, branch)) {
    // Re-dispatch onto a leftover branch → force the ref to the fresh spec commit.
    run(config, ['api', `repos/${repo}/git/refs/heads/${branch}`, '--method', 'PATCH', '--input', '-'],
      JSON.stringify({ sha: commitSha, force: true }));
  } else {
    run(config, ['api', `repos/${repo}/git/refs`, '--method', 'POST', '--input', '-'],
      JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }));
  }
  return commitSha;
}

export function approve(config: MergesmithConfig, pr: number, body: string): void {
  run(config, ['pr', 'review', String(pr), '--repo', config.repo, '--approve', '--body', body]);
}

export function requestChanges(config: MergesmithConfig, pr: number, body: string): void {
  run(config, ['pr', 'review', String(pr), '--repo', config.repo, '--request-changes', '--body', body]);
}

export function mergeAuto(config: MergesmithConfig, pr: number): void {
  run(config, ['pr', 'merge', String(pr), '--repo', config.repo, '--auto', '--squash']);
}

// 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' — used to tell an agent-recoverable conflict (→ rebase)
// apart from a genuine merge failure (→ human).
export function prMergeable(config: MergesmithConfig, pr: number): string {
  const out = tryRun(config, ['pr', 'view', String(pr), '--repo', config.repo, '--json', 'mergeable', '--jq', '.mergeable']);
  return out ?? 'UNKNOWN';
}

export function comment(config: MergesmithConfig, pr: number, body: string): void {
  run(config, ['pr', 'comment', String(pr), '--repo', config.repo, '--body', body]);
}

// ---- Labels (best-effort: never break the loop if a label op fails) ----

// Use the REST API, NOT `gh pr edit --add-label`: the latter goes through GraphQL and
// fails silently on the deprecated Projects-classic `projectCards` field (exits 0, no-op).
export function addLabels(config: MergesmithConfig, pr: number, labels: string[]): void {
  if (labels.length === 0) return;
  const args = ['api', '--method', 'POST', `repos/${config.repo}/issues/${pr}/labels`];
  for (const label of labels) args.push('-f', `labels[]=${label}`);
  tryRun(config, args);
}

export function removeLabels(config: MergesmithConfig, pr: number, labels: string[]): void {
  for (const label of labels) {
    tryRun(config, ['api', '--method', 'DELETE', `repos/${config.repo}/issues/${pr}/labels/${encodeURIComponent(label)}`]);
  }
}

// Idempotent (create-or-update via --force). Used at runtime by `ensure-labels` (bot has access).
export function ensureLabel(config: MergesmithConfig, name: string, color: string, description: string): void {
  run(config, ['label', 'create', name, '--repo', config.repo, '--color', color, '--description', description, '--force']);
}

// ---- Issues (work-source) ----
// PRs and issues share the /issues/{n}/labels endpoint, so addLabels/removeLabels work for both.

export interface IssueMeta {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export function getIssue(config: MergesmithConfig, n: number): IssueMeta {
  const out = run(config, ['issue', 'view', String(n), '--repo', config.repo, '--json', 'number,title,body,labels']);
  const raw = JSON.parse(out) as {
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
  };
  return { number: raw.number, title: raw.title, body: raw.body ?? '', labels: raw.labels.map((l) => l.name) };
}

export function listOpenIssuesWithLabel(config: MergesmithConfig, label: string): number[] {
  const out = run(config, [
    'issue', 'list', '--repo', config.repo, '--state', 'open', '--label', label, '--json', 'number',
  ]);
  return (JSON.parse(out) as Array<{ number: number }>).map((i) => i.number);
}

// Create an issue (labels must already exist — `mergesmith init`/`ensure-labels` create them).
// Returns the new issue number, parsed from the URL `gh issue create` prints.
export function createIssue(config: MergesmithConfig, title: string, body: string, labels: string[]): number {
  const args = ['issue', 'create', '--repo', config.repo, '--title', title, '--body', body];
  for (const label of labels) args.push('--label', label);
  const out = run(config, args);
  const match = out.match(/\/issues\/(\d+)\s*$/);
  if (!match) throw new Error(`gh issue create: URL issue non parsabile dall'output: ${out}`);
  return Number(match[1]);
}

// ---- Setup-time helpers (`mergesmith init`) ----
// These use the DEFAULT gh auth (the human admin running init), NOT the automation bot token:
// applying a branch ruleset needs repo ADMIN, and at onboarding the bot may not have access yet.

function runAsUser(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
}

/** GitHub login of the current gh auth, or null if not authenticated. */
export function whoami(): string | null {
  try {
    return runAsUser(['api', 'user', '--jq', '.login']);
  } catch {
    return null;
  }
}

export function rulesetExists(config: MergesmithConfig, name: string): boolean {
  try {
    const out = runAsUser(['api', `repos/${config.repo}/rulesets`, '--jq', '.[].name']);
    return out.split('\n').includes(name);
  } catch {
    return false;
  }
}

export function createRuleset(config: MergesmithConfig, jsonPath: string): void {
  runAsUser(['api', '-X', 'POST', `repos/${config.repo}/rulesets`, '--input', jsonPath]);
}

export function ensureLabelAsUser(config: MergesmithConfig, name: string, color: string, description: string): void {
  runAsUser(['label', 'create', name, '--repo', config.repo, '--color', color, '--description', description, '--force']);
}
