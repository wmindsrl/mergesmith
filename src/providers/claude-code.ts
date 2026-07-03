// Verifier provider: Claude Code CLI, headless. Runs the review slash command in a fresh
// session; the command writes a structured Verdict JSON to $MERGESMITH_VERDICT, which we
// read back. The verifier is "thin": it judges only — the orchestrator (act.ts) does the
// GitHub actions (approve/merge/followup/labels).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Verdict, VerifierProvider, VerifyInput } from './types.js';

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min

// The review runs in a sandbox that blocks env-var reads (and node/bash script execution),
// so we cannot pass the output path via an env var. The command writes this fixed file in
// the repo root (cwd) and we read it back from there.
const VERDICT_FILE = 'mergesmith-verdict.json';

// Settable via alias (left column) or full id. `claude --model` validates at runtime.
const CLAUDE_MODELS = [
  'opus    (claude-opus-4-8)',
  'sonnet  (claude-sonnet-5)',
  'haiku   (claude-haiku-4-5-20251001)',
  'fable   (claude-fable-5)',
];

export function createClaudeCodeProvider(opts: {
  command: string;
  repo: string;
  model?: string;
  timeoutMs?: number;
}): VerifierProvider {
  return {
    id: 'claude-code',

    async listModels(): Promise<string[]> {
      return CLAUDE_MODELS;
    },

    async verify(input: VerifyInput): Promise<Verdict> {
      const out = join(process.cwd(), VERDICT_FILE);
      if (existsSync(out)) rmSync(out);

      const args = ['-p', `${opts.command} ${input.prNumber}`, '--permission-mode', 'acceptEdits'];
      if (opts.model) args.push('--model', opts.model);
      try {
        execFileSync('claude', args, {
          stdio: ['ignore', 'inherit', 'inherit'],
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      } catch (error) {
        throw new Error(`verifier claude-code: sessione fallita per PR #${input.prNumber}: ${String(error)}`);
      }

      if (!existsSync(out)) {
        throw new Error(
          `verifier claude-code: nessun verdetto prodotto per PR #${input.prNumber} ` +
            `(${out} assente) — la review non ha scritto ${VERDICT_FILE}`,
        );
      }
      const verdict = JSON.parse(readFileSync(out, 'utf8')) as Verdict;
      rmSync(out); // cleanup so a stale verdict can't be reused next run
      if (verdict.decision !== 'APPROVE' && verdict.decision !== 'REQUEST_CHANGES') {
        throw new Error(`verifier claude-code: decision non valida nel verdetto: ${JSON.stringify(verdict.decision)}`);
      }
      verdict.comments ??= [];
      verdict.attribution = { engine: 'claude-code', ...(opts.model ? { model: opts.model } : {}) };
      return verdict;
    },
  };
}
