// mergesmith.config.json loader + validation (fail-loud) + derived paths.
// The config is the single place that decouples the engine from any specific repo.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LabelConfig {
  enabled: boolean;
  managed: string;
  ciRed: string;
  rework: string;
  needsHuman: string;
  approved: string;
}

export interface ImplementerConfig {
  provider: string;
  model?: string;
  apiKeyEnv: string;
  branchPrefix: string;
}

export interface VerifierConfig {
  provider: string;
  command: string;
  /** Model override for the review (claude-code: `claude --model`; cursor-agent: `agent --model`). */
  model?: string;
  /** Env var for Cursor API key when provider is cursor-agent. Defaults to implementer.apiKeyEnv. */
  apiKeyEnv?: string;
}

export interface SlackConfig {
  botTokenEnv: string;
  channel?: string;
  channelEnv?: string;
  mentionUserIdEnv?: string;
}

export interface IssueLabelConfig {
  ready: string;
  inProgress: string;
  needsTriage: string;
  completed: string;
}

export interface MergesmithConfig {
  repo: string;
  base: string;
  specDir: string;
  ci: { workflowName: string };
  slack: SlackConfig;
  implementer: ImplementerConfig;
  verifier: VerifierConfig;
  github: { tokenEnv: string };
  contract: { appendix: string };
  criticalPaths: string;
  labels: LabelConfig;
  issues: IssueLabelConfig;
}

export const DEFAULT_ISSUE_LABELS: IssueLabelConfig = {
  ready: 'mergesmith:ready',
  inProgress: 'mergesmith:in-progress',
  needsTriage: 'mergesmith:needs-triage',
  completed: 'mergesmith:completed',
};

export const DEFAULT_LABELS: LabelConfig = {
  enabled: true,
  managed: 'mergesmith',
  ciRed: 'mergesmith:ci-red',
  rework: 'mergesmith:rework',
  needsHuman: 'mergesmith:needs-human',
  approved: 'mergesmith:approved',
};

interface RawConfig {
  repo?: string;
  base?: string;
  specDir?: string;
  ci?: { workflowName?: string };
  slack?: Partial<SlackConfig>;
  implementer?: Partial<ImplementerConfig>;
  verifier?: Partial<VerifierConfig>;
  github?: { tokenEnv?: string };
  contract?: { appendix?: string };
  criticalPaths?: string;
  labels?: Partial<LabelConfig>;
  issues?: Partial<IssueLabelConfig>;
}

export function configPath(cwd: string = process.cwd()): string {
  return join(cwd, 'mergesmith.config.json');
}

export function loadConfig(cwd: string = process.cwd()): MergesmithConfig {
  const path = configPath(cwd);
  if (!existsSync(path)) {
    throw new Error(`mergesmith.config.json non trovato in ${cwd} — esegui \`mergesmith init\``);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;

  if (!raw.repo) throw new Error('mergesmith.config.json: campo obbligatorio "repo" mancante (es. "org/name")');
  if (!raw.implementer?.provider) throw new Error('mergesmith.config.json: "implementer.provider" mancante');
  if (!raw.verifier?.provider) throw new Error('mergesmith.config.json: "verifier.provider" mancante');

  return {
    repo: raw.repo,
    base: raw.base ?? 'main',
    specDir: raw.specDir ?? 'docs/superpowers/specs',
    ci: { workflowName: raw.ci?.workflowName ?? 'CI' },
    slack: {
      botTokenEnv: raw.slack?.botTokenEnv ?? 'SLACK_BOT_TOKEN',
      channel: raw.slack?.channel,
      channelEnv: raw.slack?.channelEnv ?? 'SLACK_CHANNEL_DEV',
      mentionUserIdEnv: raw.slack?.mentionUserIdEnv ?? 'SLACK_MENTION_USER_ID',
    },
    implementer: {
      provider: raw.implementer.provider,
      model: raw.implementer.model,
      apiKeyEnv: raw.implementer.apiKeyEnv ?? 'CURSOR_API_KEY',
      branchPrefix: raw.implementer.branchPrefix ?? 'cursor/',
    },
    verifier: {
      provider: raw.verifier.provider,
      command:
        raw.verifier.command ??
        (raw.verifier.provider === 'cursor-agent' || raw.verifier.provider === 'cursor'
          ? '.cursor/commands/mergesmith-validate-pr.md'
          : '/validate-pr'),
      model: raw.verifier.model,
      apiKeyEnv: raw.verifier.apiKeyEnv,
    },
    github: { tokenEnv: raw.github?.tokenEnv ?? 'GH_TOKEN_MERGESMITH' },
    contract: { appendix: raw.contract?.appendix ?? 'docs/agents/CONTRACT.md' },
    criticalPaths: raw.criticalPaths ?? '.github/CODEOWNERS',
    labels: { ...DEFAULT_LABELS, ...(raw.labels ?? {}) },
    issues: { ...DEFAULT_ISSUE_LABELS, ...(raw.issues ?? {}) },
  };
}

// ---- Derived state paths (centralized under ~/.mergesmith, keyed per repo) ----

export function mergesmithHome(): string {
  return process.env.MERGESMITH_HOME ?? join(homedir(), '.mergesmith');
}

export function repoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function stateDir(repo: string): string {
  return join(mergesmithHome(), 'state', repoSlug(repo));
}

export function statePath(repo: string): string {
  return join(stateDir(repo), 'state.json');
}

export function reviewedPath(repo: string): string {
  return join(stateDir(repo), 'reviewed.json');
}

export function verdictPath(repo: string, pr: number): string {
  return join(stateDir(repo), 'verdicts', `${pr}.json`);
}

export function reposRegistryPath(): string {
  return join(mergesmithHome(), 'repos.json');
}

/** Global pause flag: if this file exists, the tick skips all work (kill switch). */
export function pausedFlagPath(): string {
  return join(mergesmithHome(), 'PAUSED');
}

/** Last-successful-tick heartbeat (for `mergesmith health` / dead-man's-switch checks). */
export function heartbeatPath(repo: string): string {
  return join(stateDir(repo), 'heartbeat.json');
}
