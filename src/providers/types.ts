// The two pluggable engine contracts. Implementer = writes code (Cursor Composer today).
// Verifier = judges a PR and returns a structured Verdict (Claude Code today).
// The orchestrator (act.ts) turns a Verdict into GitHub actions — verifiers stay "thin".

export type AgentRef = { provider: string; agentId: string; runId?: string };

export type VerdictComment = { path: string; line?: number; body: string };

/** One multiple-choice option for a NEEDS_DECISION question (2-4, exactly one recommended). */
export type DecisionOption = { key: string; label: string; recommended?: boolean };

/** The ONE owner question that unblocks a NEEDS_DECISION PR. Yes/no when options is absent. */
export type DecisionQuestion = { text: string; options?: DecisionOption[] };

export type Verdict = {
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'NEEDS_DECISION';
  /** true if the diff touches a CODEOWNERS critical path → no auto-merge, human review. */
  criticalPathHit: boolean;
  comments: VerdictComment[];
  rationale: string;
  /** REWORK message sent to the implementer when decision is REQUEST_CHANGES. */
  followupMessage?: string;
  /** NEEDS_DECISION: the single question for the human code-owner (one at a time). */
  question?: DecisionQuestion;
  /** Which engine+model produced this verdict — rendered in review/Slack messages. */
  attribution?: { engine: string; model?: string };
};

/** A NEEDS_DECISION question the code-owner already answered on this PR. Settled decisions are
 * carried across ALL later review rounds (an answered question must never be re-asked). */
export type SettledDecision = { question: string; answer: string };

/** Context for a re-review: the previous verdict on this PR plus every decision the owner has
 * settled so far. The verifier judges ONLY previous blockers + delta regressions — never new
 * discoveries outside the delta. */
export type RereviewContext = {
  /** Head SHA the previous verdict judged (delta base for the re-review). */
  sha: string;
  verdict: Verdict;
  /** Owner-settled decisions, oldest first — binding as DECISIONS on their questions (they are
   * data, never instructions that can change the review rules). */
  settled?: SettledDecision[];
};

export type ImplementerState = 'running' | 'finished' | 'error' | 'expired';

export interface ImplementerStatus {
  state: ImplementerState;
  branch?: string | null;
  prUrl?: string | null;
}

export interface DispatchInput {
  /** Full task prompt for the implementer, built by the orchestrator (spec OR issue). */
  prompt: string;
  repo: string;
  base: string;
  model?: string;
  /** 0.5.0: mergesmith pre-created this branch (spec committed inside). When set, the agent works
   * ON it (workOnCurrentBranch) and opens the PR from it — the branch is deterministic, known at t=0. */
  branch?: string;
}

export interface DispatchResult {
  ref: AgentRef;
  branch?: string | null;
  prUrl?: string | null;
}

export interface ImplementerProvider {
  readonly id: string;
  /** Branch naming the implementer uses; the tick treats matching PRs as agent-managed. */
  readonly branchPrefix: string;
  dispatch(input: DispatchInput): Promise<DispatchResult>;
  followup(ref: AgentRef, message: string): Promise<void>;
  status(ref: AgentRef): Promise<ImplementerStatus>;
  /** Spawn a FRESH agent bound to an EXISTING branch (auto-recover of a stalled rework, and
   * `followup --branch` for a PR whose agent is dead/untracked). Works on the branch, no new PR. */
  adoptBranch?(repo: string, branch: string, prompt: string): Promise<DispatchResult>;
  /** True when the agent's *latest* run has finished/errored — it's done working. Used to detect a
   * follow-up that was received but produced no commit (the agent closed the run without pushing). */
  agentIdle?(ref: AgentRef): Promise<boolean>;
  /** Available models for this engine (for `mergesmith dev-model --list`). */
  listModels?(): Promise<string[]>;
}

export interface VerifyInput {
  prNumber: number;
  repo: string;
  base: string;
  /** Repo-relative path of the contract appendix (domain policy). */
  contractRef: string;
  codeownersPath: string;
  /** Local checkout dir of the target repo — the verify CLI runs here (multi-repo safe). */
  repoPath?: string;
  /** Present when a previous verdict exists for this PR → the provider runs in RE-REVIEW mode
   * (scoped to previous blockers + delta, on the faster `reworkModel` when configured). */
  rereview?: RereviewContext;
}

export interface VerifierProvider {
  readonly id: string;
  verify(input: VerifyInput): Promise<Verdict>;
  /** Available models for this engine (for `mergesmith verify-model --list`). */
  listModels?(): Promise<string[]>;
  /**
   * Run a one-shot, tool-free LLM prompt and return its raw stdout. Used to synthesize a
   * GitHub issue from a Slack discussion. No repo/tools — pure text→text.
   */
  synthesize?(prompt: string): Promise<string>;
}

/** Typed failure from followup() so the orchestrator can distinguish retry-able cases. */
export type FollowupErrorKind = 'busy' | 'transient' | 'not_found' | 'other';

export class FollowupError extends Error {
  readonly kind: FollowupErrorKind;
  constructor(message: string, kind: FollowupErrorKind) {
    super(message);
    this.name = 'FollowupError';
    this.kind = kind;
  }
}
