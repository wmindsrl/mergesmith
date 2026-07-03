// Implementer provider: Cursor Cloud Agents API (api.cursor.com).
import { loadEnvVar } from '../lib.js';
import {
  FollowupError,
  type AgentRef,
  type DispatchInput,
  type DispatchResult,
  type ImplementerProvider,
  type ImplementerState,
  type ImplementerStatus,
} from './types.js';

const API_BASE = 'https://api.cursor.com';

interface RunInfo {
  status?: string;
  git?: { branches?: Array<{ branch: string; prUrl?: string }> };
}

async function cursorFetch(apiKeyEnv: string, path: string, init?: RequestInit): Promise<unknown> {
  const apiKey = loadEnvVar(apiKeyEnv);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Cursor API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return body ? JSON.parse(body) : null;
}

const STATUS_MAP: Record<string, ImplementerState> = {
  RUNNING: 'running',
  CREATING: 'running',
  PENDING: 'running',
  FINISHED: 'finished',
  ERROR: 'error',
  EXPIRED: 'expired',
};

export function createCursorProvider(opts: {
  apiKeyEnv: string;
  branchPrefix: string;
  model?: string;
}): ImplementerProvider {
  return {
    id: 'cursor',
    branchPrefix: opts.branchPrefix,

    async dispatch(input: DispatchInput): Promise<DispatchResult> {
      const model = input.model ?? opts.model;
      if (!model) {
        const models = (await cursorFetch(opts.apiKeyEnv, '/v1/models')) as { items?: Array<{ id: string }> };
        const ids = (models.items ?? []).map((m) => m.id).join(', ');
        throw new Error(`Nessun model per il provider cursor. Imposta implementer.model. Disponibili: ${ids}`);
      }
      const payload = {
        prompt: {
          text:
            `Read \`${input.specPath}\` and implement it following \`${input.contractRef}\`. ` +
            `Work only within the spec's Scope. Open a PR to \`${input.base}\` using the CONTRACT PR template ` +
            `(the \`Spec:\` field is mandatory). When your self-check is fully green, mark the PR ready ` +
            `for review (NOT draft) — draft PRs are ignored by the review loop.`,
        },
        repos: [{ url: `https://github.com/${input.repo}`, startingRef: input.base }],
        autoCreatePR: true,
        model: { id: model },
      };
      // Response shape (verified live): { agent: {...}, run: {...} } — accept flat variants too.
      const created = (await cursorFetch(opts.apiKeyEnv, '/v1/agents', {
        method: 'POST',
        body: JSON.stringify(payload),
      })) as {
        id?: string;
        latestRunId?: string;
        runId?: string;
        agent?: { id: string; latestRunId?: string };
        run?: { id: string };
      };
      const agentId = created.agent?.id ?? created.id ?? '';
      const runId = created.run?.id ?? created.agent?.latestRunId ?? created.latestRunId ?? created.runId ?? '';
      if (!agentId) throw new Error(`Risposta Cursor senza agent id: ${JSON.stringify(created)}`);
      const ref: AgentRef = { provider: 'cursor', agentId, ...(runId ? { runId } : {}) };

      // Short poll to capture branch/PR as soon as the agent creates them (~60s).
      let branch: string | null = null;
      let prUrl: string | null = null;
      for (let attempt = 0; attempt < 6 && runId; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        try {
          const run = (await cursorFetch(opts.apiKeyEnv, `/v1/agents/${agentId}/runs/${runId}`)) as RunInfo;
          const first = run.git?.branches?.[0];
          if (first) {
            branch = first.branch;
            prUrl = first.prUrl ?? null;
            break;
          }
        } catch {
          break;
        }
      }
      return { ref, branch, prUrl };
    },

    async followup(ref: AgentRef, message: string): Promise<void> {
      try {
        await cursorFetch(opts.apiKeyEnv, `/v1/agents/${ref.agentId}/runs`, {
          method: 'POST',
          body: JSON.stringify({ prompt: { text: message } }),
        });
      } catch (error) {
        const text = String(error);
        // Match the status token emitted by cursorFetch ("→ 409:"), not a bare "409"
        // substring (a hex agentId could contain it).
        if (text.includes('→ 409:') || text.includes('agent_busy')) {
          throw new FollowupError(`agent ${ref.agentId} occupato (409)`, 'busy');
        }
        throw new FollowupError(text, 'other');
      }
    },

    async status(ref: AgentRef): Promise<ImplementerStatus> {
      if (!ref.runId) return { state: 'running' };
      const info = (await cursorFetch(opts.apiKeyEnv, `/v1/agents/${ref.agentId}/runs/${ref.runId}`)) as RunInfo;
      const first = info.git?.branches?.[0];
      const mapped = info.status ? STATUS_MAP[info.status] : undefined;
      return {
        state: mapped ?? 'running',
        branch: first?.branch ?? null,
        prUrl: first?.prUrl ?? null,
      };
    },
  };
}
