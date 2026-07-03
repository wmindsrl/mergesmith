// Verifier provider: Claude Code CLI, headless. Runs the review slash command in a fresh
// session; the command writes a structured Verdict JSON to $MERGESMITH_VERDICT, which we
// read back. The verifier is "thin": it judges only — the orchestrator (act.ts) does the
// GitHub actions (approve/merge/followup/labels).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { verdictPath } from '../config.js';
import type { Verdict, VerifierProvider, VerifyInput } from './types.js';

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min

export function createClaudeCodeProvider(opts: {
  command: string;
  repo: string;
  timeoutMs?: number;
}): VerifierProvider {
  return {
    id: 'claude-code',

    async verify(input: VerifyInput): Promise<Verdict> {
      const out = verdictPath(input.repo, input.prNumber);
      if (existsSync(out)) rmSync(out);
      mkdirSync(dirname(out), { recursive: true });

      const env: NodeJS.ProcessEnv = { ...process.env, MERGESMITH_VERDICT: out };
      try {
        execFileSync('claude', ['-p', `${opts.command} ${input.prNumber}`, '--permission-mode', 'acceptEdits'], {
          env,
          stdio: ['ignore', 'inherit', 'inherit'],
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      } catch (error) {
        throw new Error(`verifier claude-code: sessione fallita per PR #${input.prNumber}: ${String(error)}`);
      }

      if (!existsSync(out)) {
        throw new Error(
          `verifier claude-code: nessun verdetto prodotto per PR #${input.prNumber} ` +
            `(${out} assente) — la review non ha scritto $MERGESMITH_VERDICT`,
        );
      }
      const verdict = JSON.parse(readFileSync(out, 'utf8')) as Verdict;
      if (verdict.decision !== 'APPROVE' && verdict.decision !== 'REQUEST_CHANGES') {
        throw new Error(`verifier claude-code: decision non valida nel verdetto: ${JSON.stringify(verdict.decision)}`);
      }
      verdict.comments ??= [];
      return verdict;
    },
  };
}
