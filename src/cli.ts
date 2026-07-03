#!/usr/bin/env node
// mergesmith CLI. Thin dispatcher over the orchestrator + scaffolder.
import { loadConfig } from './config.js';
import { dispatchSpec } from './orchestrator/dispatch.js';
import { tickAll, tickRepo } from './orchestrator/tick.js';
import { markReviewed, refForBranch } from './orchestrator/state.js';
import { getImplementer } from './providers/registry.js';
import { FollowupError } from './providers/types.js';
import { postSlack } from './slack.js';
import { runInit } from './scaffold/bootstrap.js';

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
}

const HELP = `mergesmith — forge specs into merged PRs

Usage:
  mergesmith init                             Scaffold config + CODEOWNERS + labels + ruleset in this repo
  mergesmith dispatch <spec-path>             Send a spec to the implementer (opens a PR)
  mergesmith tick [--all] [--dry-run]         Poll agent-managed PRs (verify green / follow-up red)
  mergesmith followup --branch <b> --message "<m>"   Send a manual follow-up to the agent
  mergesmith notify "<text>" [--mention]      Post to the configured Slack channel
  mergesmith mark-reviewed <pr> <sha>         Mark a PR SHA as processed
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      await runInit(process.cwd());
      break;

    case 'dispatch': {
      const spec = rest.find((a) => !a.startsWith('--'));
      if (!spec) throw new Error('Uso: mergesmith dispatch <spec-path>');
      await dispatchSpec(loadConfig(), spec);
      break;
    }

    case 'tick': {
      const dryRun = rest.includes('--dry-run');
      if (rest.includes('--all')) await tickAll({ dryRun });
      else await tickRepo(loadConfig(), { dryRun });
      break;
    }

    case 'followup': {
      const branch = argValue(rest, '--branch');
      const message = argValue(rest, '--message');
      if (!branch || !message) throw new Error('Uso: mergesmith followup --branch <name> --message "<testo>"');
      const config = loadConfig();
      const ref = refForBranch(config.repo, branch);
      if (!ref) {
        console.error(`✗ nessun agent noto per il branch "${branch}"`);
        process.exit(3);
      }
      try {
        await getImplementer(config).followup(ref, message);
        console.log(`✓ follow-up inviato (${branch})`);
      } catch (error) {
        if (error instanceof FollowupError && error.kind === 'busy') {
          console.error(`✗ agent occupato: ${error.message}`);
          process.exit(2);
        }
        throw error;
      }
      break;
    }

    case 'notify': {
      const text = rest.find((a) => !a.startsWith('--'));
      if (!text) throw new Error('Uso: mergesmith notify "<testo>" [--mention]');
      await postSlack(loadConfig().slack, text, { mention: rest.includes('--mention') });
      console.log('✓ notifica inviata');
      break;
    }

    case 'mark-reviewed': {
      const [pr, sha] = rest;
      if (!pr || !sha) throw new Error('Uso: mergesmith mark-reviewed <pr> <sha>');
      markReviewed(loadConfig().repo, Number(pr), sha);
      console.log(`✓ PR #${pr} marcata: ${sha}`);
      break;
    }

    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      break;

    default:
      console.error(`Comando sconosciuto: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
