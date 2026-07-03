// Local, per-repo state: dispatched runs + reviewed SHAs. Centralized under ~/.mergesmith.
import { readJson, writeJson } from '../lib.js';
import { reviewedPath, statePath } from '../config.js';
import type { AgentRef } from '../providers/types.js';

export interface RunRecord {
  specId: string;
  specPath: string;
  ref: AgentRef;
  base: string;
  branch: string | null;
  prUrl: string | null;
  dispatchedAt: string;
  done?: boolean;
}

export interface IssueRecord {
  issueNumber: number;
  ref: AgentRef;
  branch: string | null;
  prUrl: string | null;
  dispatchedAt: string;
  done?: boolean;
}

export interface StateFile {
  runs: Record<string, RunRecord>;
  issues?: Record<string, IssueRecord>;
}

export function recordIssue(repo: string, rec: IssueRecord): void {
  const state = loadState(repo);
  state.issues ??= {};
  state.issues[String(rec.issueNumber)] = rec;
  saveState(repo, state);
}

export function issueDispatched(repo: string, issueNumber: number): boolean {
  return Boolean(loadState(repo).issues?.[String(issueNumber)]);
}

export function loadState(repo: string): StateFile {
  return readJson<StateFile>(statePath(repo), { runs: {} });
}

export function saveState(repo: string, state: StateFile): void {
  writeJson(statePath(repo), state);
}

export function knownBranches(repo: string): string[] {
  return Object.values(loadState(repo).runs)
    .map((r) => r.branch)
    .filter((b): b is string => !!b);
}

export function refForBranch(repo: string, branch: string): AgentRef | null {
  return Object.values(loadState(repo).runs).find((r) => r.branch === branch)?.ref ?? null;
}

export function loadReviewed(repo: string): Record<string, string> {
  return readJson<Record<string, string>>(reviewedPath(repo), {});
}

export function markReviewed(repo: string, pr: number, sha: string): void {
  const reviewed = loadReviewed(repo);
  reviewed[String(pr)] = sha;
  writeJson(reviewedPath(repo), reviewed);
}
