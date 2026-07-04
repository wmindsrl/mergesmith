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

// Network blip / rate-limit / 5xx from the Cursor API — retryable, unlike a real 4xx.
export function isTransientError(text: string): boolean {
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|terminated|→ (429|5\d\d):/i.test(text);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Retries transient failures (network blip / 429 / 5xx) in-call so a flaky WSL/Tailscale network
// doesn't drop a follow-up/dispatch — leaving a PR stuck in rework, re-reviewed every tick without
// the agent ever getting the instruction. A real 4xx (404, 409 busy, …) surfaces immediately.
async function cursorFetch(apiKeyEnv: string, path: string, init?: RequestInit): Promise<unknown> {
  const apiKey = loadEnvVar(apiKeyEnv);
  const url = `${API_BASE}${path}`;
  const opts: RequestInit = {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      lastErr = err; // network blip (fetch failed) → retry
      await sleep(400 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Cursor API ${init?.method ?? 'GET'} ${path} → ${res.status}`);
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`Cursor API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
    return body ? JSON.parse(body) : null;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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

    async listModels(): Promise<string[]> {
      const models = (await cursorFetch(opts.apiKeyEnv, '/v1/models')) as { items?: Array<{ id: string }> };
      return (models.items ?? []).map((m) => m.id);
    },

    async dispatch(input: DispatchInput): Promise<DispatchResult> {
      const model = input.model ?? opts.model;
      if (!model) {
        const models = (await cursorFetch(opts.apiKeyEnv, '/v1/models')) as { items?: Array<{ id: string }> };
        const ids = (models.items ?? []).map((m) => m.id).join(', ');
        throw new Error(`Nessun model per il provider cursor. Imposta implementer.model. Disponibili: ${ids}`);
      }
      const payload = {
        prompt: { text: input.prompt },
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
        // Network blip / rate-limit / 5xx → retry next tick, don't escalate to needs-human.
        if (isTransientError(text)) {
          throw new FollowupError(text, 'transient');
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

    async adoptBranch(repo: string, branch: string, prompt: string): Promise<DispatchResult> {
      const model = opts.model;
      const payload: Record<string, unknown> = {
        prompt: { text: prompt },
        repos: [{ url: `https://github.com/${repo}`, startingRef: branch }],
        workOnCurrentBranch: true, // edit + push the existing branch; the PR already exists
        autoCreatePR: false,
        ...(model ? { model: { id: model } } : {}),
      };
      const created = (await cursorFetch(opts.apiKeyEnv, '/v1/agents', {
        method: 'POST',
        body: JSON.stringify(payload),
      })) as { id?: string; latestRunId?: string; runId?: string; agent?: { id: string; latestRunId?: string }; run?: { id: string } };
      const agentId = created.agent?.id ?? created.id ?? '';
      const runId = created.run?.id ?? created.agent?.latestRunId ?? created.latestRunId ?? created.runId ?? '';
      if (!agentId) throw new Error(`Risposta Cursor senza agent id: ${JSON.stringify(created)}`);
      return { ref: { provider: 'cursor', agentId, ...(runId ? { runId } : {}) }, branch, prUrl: null };
    },

    // The agent's LATEST run (not the original) — a follow-up creates a new run; if that run is
    // FINISHED and no commit landed, the follow-up didn't take. Fail-safe: on error return false
    // (assume still working) so we never recover a live agent prematurely.
    async agentIdle(ref: AgentRef): Promise<boolean> {
      try {
        const agent = (await cursorFetch(opts.apiKeyEnv, `/v1/agents/${ref.agentId}`)) as { latestRunId?: string };
        const runId = agent.latestRunId ?? ref.runId;
        if (!runId) return false;
        const run = (await cursorFetch(opts.apiKeyEnv, `/v1/agents/${ref.agentId}/runs/${runId}`)) as RunInfo;
        const state = run.status ? STATUS_MAP[run.status] : undefined;
        return state === 'finished' || state === 'error' || state === 'expired';
      } catch {
        return false;
      }
    },
  };
}
