// The two pluggable engine contracts. Implementer = writes code (Cursor Composer today).
// Verifier = judges a PR and returns a structured Verdict (Claude Code today).
// The orchestrator (act.ts) turns a Verdict into GitHub actions — verifiers stay "thin".

export type AgentRef = { provider: string; agentId: string; runId?: string };

export type VerdictComment = { path: string; line?: number; body: string };

export type Verdict = {
  decision: 'APPROVE' | 'REQUEST_CHANGES';
  /** true if the diff touches a CODEOWNERS critical path → no auto-merge, human review. */
  criticalPathHit: boolean;
  comments: VerdictComment[];
  rationale: string;
  /** REWORK message sent to the implementer when decision is REQUEST_CHANGES. */
  followupMessage?: string;
  /** Which engine+model produced this verdict — rendered in review/Slack messages. */
  attribution?: { engine: string; model?: string };
};

export type ImplementerState = 'running' | 'finished' | 'error' | 'expired';

export interface ImplementerStatus {
  state: ImplementerState;
  branch?: string | null;
  prUrl?: string | null;
}

export interface DispatchInput {
  specText: string;
  specPath: string;
  repo: string;
  base: string;
  /** Repo-relative path of the contract the implementer must follow. */
  contractRef: string;
  model?: string;
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
}

export interface VerifyInput {
  prNumber: number;
  repo: string;
  base: string;
  /** Repo-relative path of the contract appendix (domain policy). */
  contractRef: string;
  codeownersPath: string;
}

export interface VerifierProvider {
  readonly id: string;
  verify(input: VerifyInput): Promise<Verdict>;
  /** Available models for this engine (for `mergesmith verify-model --list`). */
  listModels?(): Promise<string[]>;
}

/** Typed failure from followup() so the orchestrator can distinguish retry-able cases. */
export type FollowupErrorKind = 'busy' | 'not_found' | 'other';

export class FollowupError extends Error {
  readonly kind: FollowupErrorKind;
  constructor(message: string, kind: FollowupErrorKind) {
    super(message);
    this.name = 'FollowupError';
    this.kind = kind;
  }
}
