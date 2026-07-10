#!/usr/bin/env node
// mergesmith CLI. Thin dispatcher over the orchestrator + scaffolder.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadConfig, configPath, heartbeatPath, pausedFlagPath } from './config.js';
import { readJson } from './lib.js';
import { dispatchSpec } from './orchestrator/dispatch.js';
import { dispatchIssue } from './orchestrator/issue.js';
import { tickAll, tickRepo } from './orchestrator/tick.js';
import { watchAll, watchRepo } from './orchestrator/watch.js';
import { markReviewed, refForBranch, setRefForBranch } from './orchestrator/state.js';
import { getImplementer, getVerifier } from './providers/registry.js';
import { ensureLabel } from './github.js';
import { FollowupError } from './providers/types.js';
import { postSlack } from './slack.js';
import { pollInbox } from './inbox.js';
import { postRecap } from './recap.js';
import { runInit } from './scaffold/bootstrap.js';

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
}

const HELP = `mergesmith — forge specs into merged PRs

Usage:
  mergesmith init                             Scaffold config + CODEOWNERS + labels + ruleset in this repo
  mergesmith dispatch <spec-path>|--issue <n> Send a spec or a GitHub issue to the implementer
  mergesmith tick [--all] [--dry-run]         Poll agent-managed PRs (verify green / follow-up red)
  mergesmith watch [--all] [--interval <s>] [--max-runtime <m>]
                                              Pipeline mode: scan continuo, ogni PR avanza appena il suo
                                              gate si apre (niente attesa del prossimo tick). Il cron
                                              diventa watchdog: rilancia il watch quando esce.
  mergesmith followup --branch <b> --message "<m>"   Send a manual follow-up to the agent
  mergesmith notify "<text>" [--mention]      Post to the configured Slack channel
  mergesmith inbox                            Poll Slack for !go-finalized threads → GitHub issues
  mergesmith recap                            Post a state snapshot (PRs + issues) to Slack
  mergesmith mark-reviewed <pr> <sha>         Mark a PR SHA as processed
  mergesmith verify-model [--list] [<model>]  Get/set the review model (verifier.model)
  mergesmith dev-model [--list] [<model>]     Get/set the implementer model (implementer.model)
  mergesmith ensure-labels                    Create the PR state labels in the repo (idempotent)
  mergesmith pause | resume                   Stop / restart the loop (kill switch, no crontab edit)
  mergesmith health                           Show last-tick heartbeat + pause state
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      await runInit(process.cwd());
      break;

    case 'dispatch': {
      const issueArg = argValue(rest, '--issue');
      if (issueArg) {
        await dispatchIssue(loadConfig(), Number(issueArg), argValue(rest, '--base') ?? undefined);
        break;
      }
      const spec = rest.find((a) => !a.startsWith('--'));
      if (!spec) throw new Error('Uso: mergesmith dispatch <spec-path> | --issue <n>');
      await dispatchSpec(loadConfig(), spec);
      break;
    }

    case 'tick': {
      const dryRun = rest.includes('--dry-run');
      const all = rest.includes('--all');
      try {
        if (all) await tickAll({ dryRun });
        else await tickRepo(loadConfig(), { dryRun });
      } catch (error) {
        // Systemic failure (e.g. expired token → every call fails): alert Slack, then rethrow.
        if (!all && !dryRun) {
          try {
            const cfg = loadConfig();
            await postSlack(
              cfg.slack,
              `:rotating_light: mergesmith tick FALLITO su ${cfg.repo}: ${error instanceof Error ? error.message : String(error)}`,
              { mention: true },
            );
          } catch {
            /* alert best-effort: non nascondere l'errore originale */
          }
        }
        throw error;
      }
      break;
    }

    case 'watch': {
      const intervalArg = argValue(rest, '--interval');
      const maxRuntimeArg = argValue(rest, '--max-runtime');
      const opts = {
        ...(intervalArg ? { intervalMs: Number(intervalArg) * 1000 } : {}),
        ...(maxRuntimeArg ? { maxRuntimeMs: Number(maxRuntimeArg) * 60_000 } : {}),
      };
      try {
        if (rest.includes('--all')) await watchAll(opts);
        else await watchRepo(loadConfig(), opts);
      } catch (error) {
        // Systemic failure: alert Slack, then rethrow (the cron watchdog will restart us).
        try {
          const cfg = loadConfig();
          await postSlack(
            cfg.slack,
            `:rotating_light: mergesmith watch FALLITO su ${cfg.repo}: ${error instanceof Error ? error.message : String(error)}`,
            { mention: true },
          );
        } catch {
          /* alert best-effort: non nascondere l'errore originale */
        }
        throw error;
      }
      break;
    }

    case 'followup': {
      const branch = argValue(rest, '--branch');
      const message = argValue(rest, '--message');
      if (!branch || !message) throw new Error('Uso: mergesmith followup --branch <name> --message "<testo>"');
      const config = loadConfig();
      const impl = getImplementer(config);
      const ref = refForBranch(config.repo, branch);
      try {
        if (ref) {
          await impl.followup(ref, message);
          console.log(`✓ follow-up inviato all'agent noto (${branch})`);
        } else if (impl.adoptBranch) {
          // No tracked agent → spawn a fresh one bound to the branch (also the auto-recover path).
          const res = await impl.adoptBranch(config.repo, branch, message);
          setRefForBranch(config.repo, branch, res.ref);
          console.log(`✓ nessun agent noto — spawnato agent fresco sul branch (${branch})`);
        } else {
          console.error(`✗ nessun agent noto per "${branch}" e il provider non supporta adoptBranch`);
          process.exit(3);
        }
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

    case 'inbox': {
      // One-shot poll (the tick runs this each cycle; this is for manual/testing runs).
      await pollInbox(loadConfig());
      console.log('✓ inbox poll completato');
      break;
    }

    case 'recap': {
      // On-demand snapshot. Schedule a separate cron (e.g. daily) for a recurring recap.
      await postRecap(loadConfig());
      console.log('✓ recap inviato');
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
        [config.issues.ready, '0e8a16', 'Issue ready to dispatch'],
        [config.issues.inProgress, '1d76db', 'Issue dispatched — in progress'],
        [config.issues.needsTriage, 'ededed', 'Issue needs human triage before dispatch'],
        [config.issues.completed, '0052cc', 'Issue work merged (auto-closes when the branch reaches main)'],
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

    case 'pause': {
      writeFileSync(pausedFlagPath(), `${new Date().toISOString()}\n`);
      console.log(`✓ loop in pausa (${pausedFlagPath()}). Riprendi con: mergesmith resume`);
      break;
    }

    case 'resume': {
      if (existsSync(pausedFlagPath())) rmSync(pausedFlagPath());
      console.log('✓ loop ripreso (PAUSED rimosso)');
      break;
    }

    case 'health': {
      const config = loadConfig();
      const hb = readJson<{ lastTick?: string }>(heartbeatPath(config.repo), {});
      console.log(`repo:            ${config.repo}`);
      console.log(`in pausa:        ${existsSync(pausedFlagPath()) ? 'SÌ (PAUSED presente)' : 'no'}`);
      if (hb.lastTick) {
        const ageMin = Math.round((Date.now() - new Date(hb.lastTick).getTime()) / 60000);
        console.log(`ultimo tick ok:  ${hb.lastTick} (${ageMin} min fa)`);
      } else {
        console.log('ultimo tick ok:  (mai registrato)');
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
