// Verifier provider: Cursor Agent CLI (`agent -p`), headless. Runs the review prompt in a
// fresh session; the prompt writes mergesmith-verdict.json in the repo root, which we read back.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvVar } from '../lib.js';
import type { Verdict, VerifierProvider, VerifyInput } from './types.js';
import { readVerdict, verdictPath } from './verdict.js';

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function resolveCommandPrompt(command: string, prNumber: number, cwd: string): string {
  let path: string | null = null;
  if (command.startsWith('/') && !command.startsWith('//')) {
    path = join(cwd, '.cursor', 'commands', `${command.slice(1)}.md`);
    if (!existsSync(path)) {
      path = join(cwd, '.claude', 'commands', `${command.slice(1)}.md`);
    }
  } else if (command.endsWith('.md')) {
    path = join(cwd, command);
  }

  if (path && existsSync(path)) {
    const body = stripFrontmatter(readFileSync(path, 'utf8')).trim();
    return `${body}\n\nPR number to validate: ${prNumber}`;
  }

  return `${command} ${prNumber}`;
}

export function createCursorAgentProvider(opts: {
  command: string;
  repo: string;
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}): VerifierProvider {
  const apiKeyEnv = opts.apiKeyEnv ?? 'CURSOR_API_KEY';

  return {
    id: 'cursor-agent',

    async listModels(): Promise<string[]> {
      try {
        const out = execFileSync('agent', ['models'], {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, CURSOR_API_KEY: loadEnvVar(apiKeyEnv) },
        });
        return out
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      } catch {
        return ['composer-2.5'];
      }
    },

    async verify(input: VerifyInput): Promise<Verdict> {
      const cwd = input.repoPath ?? process.cwd();
      const out = verdictPath(cwd);
      if (existsSync(out)) rmSync(out);

      const prompt = resolveCommandPrompt(opts.command, input.prNumber, cwd);
      const args = ['-p', prompt];
      if (opts.model) args.push('--model', opts.model);

      const env = { ...process.env, CURSOR_API_KEY: loadEnvVar(apiKeyEnv) };
      try {
        execFileSync('agent', args, {
          stdio: ['ignore', 'inherit', 'inherit'],
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env,
          cwd,
        });
      } catch (error) {
        throw new Error(`verifier cursor-agent: sessione fallita per PR #${input.prNumber}: ${String(error)}`);
      }

      return readVerdict(cwd, input.prNumber, 'cursor-agent', opts.model);
    },

    async synthesize(prompt: string): Promise<string> {
      // Tool-free one-shot: capture stdout as the model's answer.
      const args = ['-p', prompt];
      if (opts.model) args.push('--model', opts.model);
      const env = { ...process.env, CURSOR_API_KEY: loadEnvVar(apiKeyEnv) };
      try {
        return execFileSync('agent', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          timeout: 300_000, // 5 min
          env,
        }).toString();
      } catch (error) {
        throw new Error(`synthesize cursor-agent fallita: ${String(error)}`);
      }
    },
  };
}
