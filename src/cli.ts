#!/usr/bin/env node
// mergesmith CLI. Thin dispatcher over the orchestrator + scaffolder.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig, configPath } from './config.js';
import { dispatchSpec } from './orchestrator/dispatch.js';
import { tickAll, tickRepo } from './orchestrator/tick.js';
import { markReviewed, refForBranch } from './orchestrator/state.js';
import { getImplementer, getVerifier } from './providers/registry.js';
import { ensureLabel } from './github.js';
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
  mergesmith verify-model [--list] [<model>]  Get/set the review model (verifier.model)
  mergesmith dev-model [--list] [<model>]     Get/set the implementer model (implementer.model)
  mergesmith ensure-labels                    Create the PR state labels in the repo (idempotent)
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

    case 'verify-model': {
      const config = loadConfig();
      if (rest.includes('--list')) {
        const verifier = getVerifier(config);
        const models = verifier.listModels ? await verifier.listModels() : [];
        console.log(
          models.length
            ? `Modelli disponibili (${verifier.id}):\n  ${models.join('\n  ')}`
            : `Il verifier "${verifier.id}" non espone una lista di modelli`,
        );
        const current = process.env.MERGESMITH_VERIFIER_MODEL ?? config.verifier.model;
        console.log(`\nattuale: ${current ?? '(default del CLI claude)'}`);
        break;
      }
      const model = rest.find((a) => !a.startsWith('--'));
      if (!model) {
        const current = process.env.MERGESMITH_VERIFIER_MODEL ?? config.verifier.model;
        console.log(`verifier.model attuale: ${current ?? '(default del CLI claude)'}`);
        break;
      }
      const path = configPath();
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        verifier?: { provider?: string; command?: string; model?: string };
      };
      raw.verifier = { ...(raw.verifier ?? {}), model };
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
      console.log(`✓ verifier.model impostato a "${model}" in ${path}`);
      break;
    }

    case 'dev-model': {
      const config = loadConfig();
      if (rest.includes('--list')) {
        const impl = getImplementer(config);
        const models = impl.listModels ? await impl.listModels() : [];
        console.log(
          models.length
            ? `Modelli disponibili (${impl.id}):\n  ${models.join('\n  ')}`
            : `Il provider "${impl.id}" non espone una lista di modelli`,
        );
        const current = process.env.MERGESMITH_IMPLEMENTER_MODEL ?? config.implementer.model;
        console.log(`\nattuale: ${current ?? '(nessuno)'}`);
        break;
      }
      const model = rest.find((a) => !a.startsWith('--'));
      if (!model) {
        const current = process.env.MERGESMITH_IMPLEMENTER_MODEL ?? config.implementer.model;
        console.log(`implementer.model attuale: ${current ?? '(nessuno)'}`);
        break;
      }
      const path = configPath();
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        implementer?: { provider?: string; model?: string; apiKeyEnv?: string; branchPrefix?: string };
      };
      raw.implementer = { ...(raw.implementer ?? {}), model };
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
      console.log(`✓ implementer.model impostato a "${model}" in ${path}`);
      break;
    }

    case 'ensure-labels': {
      const config = loadConfig();
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
          console.log(`✓ ${name}`);
        } catch (error) {
          console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
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
