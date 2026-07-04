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
  /** 0.5.0: SHA of the spec commit mergesmith put on the branch. After the run finishes,
   * branchHead === specSha ⇒ the agent delivered nothing (no-op stall). */
  specSha?: string;
  /** 0.5.0: how many times sweepDispatchStalls has auto-recovered this run (cap before needs-human). */
  recoverAttempts?: number;
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

export interface ReworkRecord {
  sha: string; // the head SHA that got REQUEST_CHANGES — rework is "delivered" when the SHA changes
  followupAt: number; // Date.now() of the last follow-up / recovery
  attempts: number; // auto-recover attempts so far
  fixPrompt: string; // the instruction to (re-)send to the agent
}

export interface StateFile {
  runs: Record<string, RunRecord>;
  issues?: Record<string, IssueRecord>;
  threads?: Record<string, ThreadRef>;
  inbox?: InboxState;
  rework?: Record<string, ReworkRecord>;
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

// Dispatch posts a visible ":rocket: Dispatch" message to the channel and stashes its ts keyed by
// branch; when the tick first sees that branch's PR it adopts this ts as the PR's thread root, so
// the whole lifecycle threads under the readable dispatch message.
export function getBranchThread(repo: string, branch: string): ThreadRef | null {
  return loadState(repo).threads?.[`branch:${branch}`] ?? null;
}

export function setBranchThread(repo: string, branch: string, ts: string, channel: string): void {
  const state = loadState(repo);
  state.threads ??= {};
  state.threads[`branch:${branch}`] = { ts, channel };
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

// Point a branch at a new agent ref (auto-recover / adoptBranch spawns a fresh agent → future
// follow-ups target it). Updates the existing run/issue record, or adds a synthetic run.
export function setRefForBranch(repo: string, branch: string, ref: AgentRef): void {
  const state = loadState(repo);
  const run = Object.values(state.runs).find((r) => r.branch === branch);
  if (run) {
    run.ref = ref;
    saveState(repo, state);
    return;
  }
  const issue = Object.values(state.issues ?? {}).find((i) => i.branch === branch);
  if (issue) {
    issue.ref = ref;
    saveState(repo, state);
    return;
  }
  state.runs[`recover:${branch}`] = {
    specId: `recover:${branch}`,
    specPath: '',
    ref,
    base: '',
    branch,
    prUrl: null,
    dispatchedAt: new Date().toISOString(),
  };
  saveState(repo, state);
}

export function getRework(repo: string, pr: number): ReworkRecord | null {
  return loadState(repo).rework?.[String(pr)] ?? null;
}

export function setRework(repo: string, pr: number, rec: ReworkRecord): void {
  const state = loadState(repo);
  state.rework ??= {};
  state.rework[String(pr)] = rec;
  saveState(repo, state);
}

export function clearRework(repo: string, pr: number): void {
  const state = loadState(repo);
  if (state.rework?.[String(pr)]) {
    delete state.rework[String(pr)];
    saveState(repo, state);
  }
}

export function loadReviewed(repo: string): Record<string, string> {
  return readJson<Record<string, string>>(reviewedPath(repo), {});
}

export function markReviewed(repo: string, pr: number, sha: string): void {
  const reviewed = loadReviewed(repo);
  reviewed[String(pr)] = sha;
  writeJson(reviewedPath(repo), reviewed);
}
