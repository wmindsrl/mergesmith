// `mergesmith init`: scaffold config + CODEOWNERS + contract appendix + ruleset template
// into a target repo, ensure the state labels exist, and print the manual checklist.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configPath, DEFAULT_LABELS, loadConfig, type MergesmithConfig } from '../config.js';
import { ensureLabel } from '../github.js';

const CONFIG_TEMPLATE = `{
  "repo": "OWNER/REPO",
  "base": "main",
  "specDir": "docs/specs",
  "ci": { "workflowName": "CI" },
  "slack": {
    "botTokenEnv": "SLACK_BOT_TOKEN",
    "channelEnv": "SLACK_CHANNEL_DEV",
    "mentionUserIdEnv": "SLACK_MENTION_USER_ID"
  },
  "implementer": {
    "provider": "cursor",
    "model": "composer-2.5",
    "apiKeyEnv": "CURSOR_API_KEY",
    "branchPrefix": "cursor/"
  },
  "verifier": { "provider": "claude-code", "command": "/validate-pr", "model": "opus" },
  "github": { "tokenEnv": "GH_TOKEN_MERGESMITH" },
  "contract": { "appendix": "docs/agents/CONTRACT.md" },
  "criticalPaths": ".github/CODEOWNERS",
  "labels": ${JSON.stringify(DEFAULT_LABELS, null, 2).replace(/\n/g, '\n  ')}
}
`;

const CODEOWNERS_TEMPLATE = `# Critical paths: PRs touching these require human review (no auto-merge).
# Replace @your-codeowner with the human owner's GitHub handle.
/.github/                @your-codeowner
/docs/agents/            @your-codeowner
/mergesmith.config.json  @your-codeowner
`;

const CONTRACT_APPENDIX_TEMPLATE = `# Contract appendix — <PROJECT>

Domain-specific review policy for this repo. The generic loop rules live in the
Mergesmith base contract (shipped with the plugin). Add here only what a verifier
must know about THIS project (logging conventions, DB migration rules,
architectural patterns, critical invariants).

## Domain rules

- (add your rules)
`;

function rulesetJson(config: MergesmithConfig): string {
  return `${JSON.stringify(
    {
      name: 'mergesmith-main',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: true,
            required_review_thread_resolution: false,
            require_last_push_approval: false,
            allowed_merge_methods: ['squash'],
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: 'ci' }],
          },
        },
        { type: 'non_fast_forward' },
        { type: 'deletion' },
      ],
    },
    null,
    2,
  )}\n`;
}

function writeIfAbsent(path: string, content: string, log: string[]): void {
  if (existsSync(path)) {
    log.push(`= esiste già, invariato: ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  log.push(`+ scritto: ${path}`);
}

export async function runInit(cwd: string): Promise<void> {
  const log: string[] = [];
  writeIfAbsent(configPath(cwd), CONFIG_TEMPLATE, log);
  writeIfAbsent(join(cwd, '.github/CODEOWNERS'), CODEOWNERS_TEMPLATE, log);
  writeIfAbsent(join(cwd, 'docs/agents/CONTRACT.md'), CONTRACT_APPENDIX_TEMPLATE, log);

  let config: MergesmithConfig | null = null;
  try {
    config = loadConfig(cwd);
  } catch {
    // config still a placeholder — fill it and re-run.
  }

  if (config && config.repo !== 'OWNER/REPO') {
    writeIfAbsent(join(cwd, '.github/mergesmith-ruleset.json'), rulesetJson(config), log);
    const L = config.labels;
    const specs: Array<[string, string, string]> = [
      [L.managed, 'ededed', 'Managed by Mergesmith'],
      [L.ciRed, 'd73a4a', 'CI failing — fix follow-up sent'],
      [L.rework, 'fbca04', 'Changes requested — rework in progress'],
      [L.needsHuman, 'd876e3', 'Critical path — human review required'],
      [L.approved, '0e8a16', 'Approved — auto-merge armed'],
    ];
    for (const [name, color, description] of specs) {
      try {
        ensureLabel(config, name, color, description);
        log.push(`+ label assicurata: ${name}`);
      } catch (error) {
        log.push(`! label "${name}" non creata (${String(error)})`);
      }
    }
  }

  console.log(log.join('\n'));
  console.log(checklist(cwd, config));
}

function checklist(cwd: string, config: MergesmithConfig | null): string {
  const repo = config && config.repo !== 'OWNER/REPO' ? config.repo : '<owner/repo>';
  return [
    '',
    '--- Manual checklist ---',
    '1. Fill mergesmith.config.json (repo, slack, provider models), then re-run `mergesmith init`.',
    `2. Apply the branch ruleset:`,
    `     gh api -X POST repos/${repo}/rulesets --input .github/mergesmith-ruleset.json`,
    '3. Install the Cursor GitHub App on the org (once per org).',
    `4. Add the automation bot as a Write collaborator on ${repo}.`,
    '5. Set env (in .env.local or the environment): CURSOR_API_KEY, SLACK_BOT_TOKEN, GH_TOKEN_MERGESMITH',
    '   (optional: SLACK_CHANNEL_DEV, SLACK_MENTION_USER_ID).',
    `6. Register this repo for the cron: add { "path": "${cwd}" } to ~/.mergesmith/repos.json.`,
    '',
  ].join('\n');
}
