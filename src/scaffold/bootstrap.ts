// `mergesmith init`: scaffold config + CODEOWNERS + contract appendix + ruleset template
// into a target repo, ensure the state labels exist, and print the manual checklist.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configPath, DEFAULT_LABELS, loadConfig, type MergesmithConfig } from '../config.js';
import { createRuleset, ensureLabelAsUser, rulesetExists, whoami } from '../github.js';

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

// No-secret CI (PR branches are untrusted). The job is named `ci` — the required status
// check referenced by the Mergesmith ruleset. Steps use --if-present so a fresh repo passes;
// CUSTOMIZE for your stack.
const CI_TEMPLATE = `name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      # CUSTOMIZE: replace with your project's build/lint/test.
      - run: |
          if [ -f package.json ]; then
            (npm ci || npm install --no-audit --no-fund)
            npm run build --if-present
            npm run lint --if-present
            npm test --if-present
          else
            echo "No package.json — replace this 'ci' job with your project's checks."
          fi
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

  // Setup runs as the human's gh identity (needs repo ADMIN for the ruleset).
  const who = whoami();
  log.push(
    who
      ? `gh autenticato come: ${who}`
      : '⚠ gh NON autenticato — esegui `gh auth login` come utente ADMIN del repo, poi ri-lancia `mergesmith init`',
  );

  writeIfAbsent(configPath(cwd), CONFIG_TEMPLATE, log);
  writeIfAbsent(join(cwd, '.github/CODEOWNERS'), CODEOWNERS_TEMPLATE, log);
  writeIfAbsent(join(cwd, '.github/workflows/ci.yml'), CI_TEMPLATE, log);
  writeIfAbsent(join(cwd, 'docs/agents/CONTRACT.md'), CONTRACT_APPENDIX_TEMPLATE, log);

  let config: MergesmithConfig | null = null;
  try {
    config = loadConfig(cwd);
  } catch {
    // config still a placeholder — fill it and re-run.
  }

  if (config && config.repo !== 'OWNER/REPO' && who) {
    const rulesetPath = join(cwd, '.github/mergesmith-ruleset.json');
    writeIfAbsent(rulesetPath, rulesetJson(config), log);

    // Apply the main-gate ruleset (idempotent): PR + code-owner review + status check "ci" + squash-only.
    if (rulesetExists(config, 'mergesmith-main')) {
      log.push('= ruleset "mergesmith-main" già presente');
    } else {
      try {
        createRuleset(config, rulesetPath);
        log.push('+ ruleset "mergesmith-main" applicato (gate su main)');
      } catch (error) {
        log.push(
          `! ruleset non applicato (${error instanceof Error ? error.message : String(error)}) — serve ADMIN; ` +
            `applicalo poi con: gh api -X POST repos/${config.repo}/rulesets --input .github/mergesmith-ruleset.json`,
        );
      }
    }

    const L = config.labels;
    const specs: Array<[string, string, string]> = [
      [L.managed, 'ededed', 'Managed by Mergesmith'],
      [L.ciRed, 'd73a4a', 'CI failing — fix follow-up sent'],
      [L.rework, 'fbca04', 'Changes requested — rework in progress'],
      [L.needsHuman, 'd876e3', 'Critical path — human review required'],
      [L.approved, '0e8a16', 'Approved — auto-merge armed'],
      [config.issues.ready, '0e8a16', 'Issue ready to dispatch'],
      [config.issues.inProgress, '1d76db', 'Issue dispatched — in progress'],
      [config.issues.needsTriage, 'ededed', 'Issue needs human triage before dispatch'],
    ];
    for (const [name, color, description] of specs) {
      try {
        ensureLabelAsUser(config, name, color, description);
        log.push(`+ label: ${name}`);
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
    '--- Steps init cannot do for you (external accounts) ---',
    '1. If config was a placeholder: fill mergesmith.config.json (repo, slack, models) and re-run `mergesmith init`.',
    '2. Install the Cursor GitHub App on the org (once per org) — an OAuth flow on GitHub.',
    `3. Add the automation bot as a Write collaborator on ${repo} (it reviews/merges with no admin bypass).`,
    '4. Set env (.env.local or environment): CURSOR_API_KEY, SLACK_BOT_TOKEN, GH_TOKEN_MERGESMITH',
    '   (optional: SLACK_CHANNEL_DEV, SLACK_MENTION_USER_ID).',
    `5. Register this repo for the cron: add { "path": "${cwd}" } to ~/.mergesmith/repos.json.`,
    '',
  ].join('\n');
}
