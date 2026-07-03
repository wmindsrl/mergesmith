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

export function approve(config: MergesmithConfig, pr: number, body: string): void {
  run(config, ['pr', 'review', String(pr), '--repo', config.repo, '--approve', '--body', body]);
}

export function requestChanges(config: MergesmithConfig, pr: number, body: string): void {
  run(config, ['pr', 'review', String(pr), '--repo', config.repo, '--request-changes', '--body', body]);
}

export function mergeAuto(config: MergesmithConfig, pr: number): void {
  run(config, ['pr', 'merge', String(pr), '--repo', config.repo, '--auto', '--squash']);
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
