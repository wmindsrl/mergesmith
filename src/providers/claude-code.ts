// Verifier provider: Claude Code CLI, headless. Runs the review slash command in a fresh
// session; the command writes mergesmith-verdict-<pr>.json in the repo root (cwd) — per-PR
// filename so CONCURRENT verifies never clobber each other (the un-suffixed legacy file
// stays as a read fallback) — which we read+validate back. The verifier is "thin": it
// judges only; the orchestrator (act.ts) does the GitHub actions. verify() spawns the CLI
// asynchronously on purpose: the tick runs verifies in a small concurrent pool.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync } from 'node:fs';
import type { Verdict, VerifierProvider, VerifyInput } from './types.js';
import { readVerdict, verdictPath, writeRereviewContext } from './verdict.js';

const execFileAsync = promisify(execFile);

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
  /** Faster model for re-reviews (scoped to previous blockers + delta). Falls back to `model`. */
  reworkModel?: string;
  timeoutMs?: number;
}): VerifierProvider {
  return {
    id: 'claude-code',

    async listModels(): Promise<string[]> {
      return CLAUDE_MODELS;
    },

    async verify(input: VerifyInput): Promise<Verdict> {
      const cwd = input.repoPath ?? process.cwd();
      const out = verdictPath(cwd, input.prNumber);
      if (existsSync(out)) rmSync(out); // pre-clean any stale per-PR verdict

      // Re-review: materialize the previous-verdict context (the command reads the file and
      // scopes itself to previous blockers + delta) and prefer the faster reworkModel.
      const cleanup = input.rereview ? writeRereviewContext(cwd, input.prNumber, input.rereview) : null;
      const model = input.rereview ? (opts.reworkModel ?? opts.model) : opts.model;

      const args = ['-p', `${opts.command} ${input.prNumber}`, '--permission-mode', 'acceptEdits'];
      if (model) args.push('--model', model);
      try {
        // Async spawn (NOT execFileSync): concurrent verifies must not block the event loop.
        await execFileAsync('claude', args, {
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          cwd,
          maxBuffer: 32 * 1024 * 1024, // review output can be large
        });
      } catch (error) {
        throw new Error(`verifier claude-code: sessione fallita per PR #${input.prNumber}: ${String(error)}`);
      } finally {
        cleanup?.();
      }
      return readVerdict(cwd, input.prNumber, 'claude-code', model);
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
