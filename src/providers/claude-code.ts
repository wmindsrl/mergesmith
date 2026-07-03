// Verifier provider: Claude Code CLI, headless. Runs the review slash command in a fresh
// session; the command writes mergesmith-verdict.json in the repo root (cwd) — its sandbox
// blocks env-var reads — which we read+validate back. The verifier is "thin": it judges
// only; the orchestrator (act.ts) does the GitHub actions.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import type { Verdict, VerifierProvider, VerifyInput } from './types.js';
import { readVerdict, verdictPath } from './verdict.js';

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min

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
      const cwd = input.repoPath ?? process.cwd();
      const out = verdictPath(cwd);
      if (existsSync(out)) rmSync(out); // pre-clean any stale verdict

      const args = ['-p', `${opts.command} ${input.prNumber}`, '--permission-mode', 'acceptEdits'];
      if (opts.model) args.push('--model', opts.model);
      try {
        execFileSync('claude', args, {
          stdio: ['ignore', 'inherit', 'inherit'],
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          cwd,
        });
      } catch (error) {
        throw new Error(`verifier claude-code: sessione fallita per PR #${input.prNumber}: ${String(error)}`);
      }
      return readVerdict(cwd, input.prNumber, 'claude-code', opts.model);
    },

    async synthesize(prompt: string): Promise<string> {
      // Tool-free one-shot: no repo, no edits. Capture stdout as the model's answer.
      const args = ['-p', prompt, '--permission-mode', 'plan'];
      if (opts.model) args.push('--model', opts.model);
      try {
        return execFileSync('claude', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          timeout: 300_000, // 5 min
        }).toString();
      } catch (error) {
        throw new Error(`synthesize claude-code fallita: ${String(error)}`);
      }
    },
  };
}
