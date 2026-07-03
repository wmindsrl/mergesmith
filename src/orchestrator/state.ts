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

export interface ThreadRef {
  ts: string;
  channel: string;
}

export interface InboxState {
  /** High-water mark: newest Slack activity ts already scanned. */
  cursor?: string;
  /** Thread-root ts values already turned into an issue (dedup: one issue per thread). */
  processed?: string[];
}

export interface StateFile {
  runs: Record<string, RunRecord>;
  issues?: Record<string, IssueRecord>;
  threads?: Record<string, ThreadRef>;
  inbox?: InboxState;
}

export function getInboxCursor(repo: string): string | undefined {
  return loadState(repo).inbox?.cursor;
}

export function isThreadProcessed(repo: string, threadTs: string): boolean {
  return loadState(repo).inbox?.processed?.includes(threadTs) ?? false;
}

export function setInboxCursor(repo: string, cursor: string): void {
  const state = loadState(repo);
  state.inbox ??= {};
  // Monotonic: never move the cursor backwards (out-of-order polls).
  if (!state.inbox.cursor || Number(cursor) > Number(state.inbox.cursor)) {
    state.inbox.cursor = cursor;
    saveState(repo, state);
  }
}

export function markThreadProcessed(repo: string, threadTs: string): void {
  const state = loadState(repo);
  state.inbox ??= {};
  state.inbox.processed ??= [];
  if (!state.inbox.processed.includes(threadTs)) {
    state.inbox.processed.push(threadTs);
    saveState(repo, state);
  }
}

export function getThread(repo: string, pr: number): ThreadRef | null {
  return loadState(repo).threads?.[`pr:${pr}`] ?? null;
}

export function setThread(repo: string, pr: number, ts: string, channel: string): void {
  const state = loadState(repo);
  state.threads ??= {};
  state.threads[`pr:${pr}`] = { ts, channel };
  saveState(repo, state);
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

export function issueForBranch(repo: string, branch: string): IssueRecord | null {
  return Object.values(loadState(repo).issues ?? {}).find((r) => r.branch === branch) ?? null;
}

export function markIssueDone(repo: string, issueNumber: number): void {
  const state = loadState(repo);
  const rec = state.issues?.[String(issueNumber)];
  if (rec) {
    rec.done = true;
    saveState(repo, state);
  }
}

export function loadState(repo: string): StateFile {
  return readJson<StateFile>(statePath(repo), { runs: {} });
}

export function saveState(repo: string, state: StateFile): void {
  writeJson(statePath(repo), state);
}

export function knownBranches(repo: string): string[] {
  const state = loadState(repo);
  return [
    ...Object.values(state.runs).map((r) => r.branch),
    ...Object.values(state.issues ?? {}).map((i) => i.branch),
  ].filter((b): b is string => !!b);
}

export function refForBranch(repo: string, branch: string): AgentRef | null {
  // Search runs (spec dispatch) AND issues (Mode A dispatch) — a branch can be tracked by either.
  const state = loadState(repo);
  const fromRuns = Object.values(state.runs).find((r) => r.branch === branch)?.ref;
  if (fromRuns) return fromRuns;
  return Object.values(state.issues ?? {}).find((i) => i.branch === branch)?.ref ?? null;
}

export function loadReviewed(repo: string): Record<string, string> {
  return readJson<Record<string, string>>(reviewedPath(repo), {});
}

export function markReviewed(repo: string, pr: number, sha: string): void {
  const reviewed = loadReviewed(repo);
  reviewed[String(pr)] = sha;
  writeJson(reviewedPath(repo), reviewed);
}
