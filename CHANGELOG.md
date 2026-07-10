# Changelog

All notable changes to `@wmind/mergesmith` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-07-10

### Added
- **`mergesmith watch` — pipeline mode.** Un processo long-lived che ri-scansiona ogni ~40s (`--interval`) e fa avanzare **ogni PR appena il suo gate si apre**: CI verde → verify subito, verdetto → follow-up subito — niente riallineamento al prossimo tick del cron (5-15 min risparmiati per round). Le verify girano in un **pool persistente** (concorrenza 3, dedup per PR): una verify lenta non blocca più il merge di un'altra PR e un solo processo possiede lo stato (niente race inter-processo, niente tick saltati dal flock). Il cron esistente diventa il **watchdog**: mentre un watch è vivo esce subito (lock per-repo, con refresh anti-steal), quando il watch termina (`--max-runtime`, default 55 min, drain pulito delle verify in corso) lo rilancia — la finestra oraria del crontab continua a delimitare quando il loop gira. L'intake Slack e gli sweep anti-stallo girano throttlati (1 scan su 4). `tick` resta per run one-shot e `--dry-run`.

## [0.6.0] — 2026-07-10

### Added
- **`NEEDS_DECISION`: le scelte vanno all'owner, non al loop.** Quando il blocco è una decisione (workaround usato dall'implementer, fork architetturale non derivabile dalla spec), il verifier emette `NEEDS_DECISION` con **una domanda alla volta** — sì/no oppure 2-4 opzioni con una `recommended`. L'orchestratore posta la domanda come commento sulla PR, pinga l'owner su Slack (emoji di stato ❓) e parcheggia la PR; la **prima risposta umana come commento** sblocca tutto: re-verify immediata con la risposta come contesto **vincolante**, e il loop riprende da solo. Validazione fail-closed del verdetto (NEEDS_DECISION senza domanda ben formata → rifiutato).
- **Re-review sul delta.** Dal round 2 il verifier riceve il verdetto precedente (`mergesmith-rereview-<pr>.json`): giudica SOLO se i blocchi precedenti sono risolti e se il delta introduce regressioni — mai scoperte nuove fuori dal delta. Nuova chiave config **`verifier.reworkModel`** (fallback su `model`, env `MERGESMITH_VERIFIER_REWORK_MODEL`): le re-review girano su un modello più veloce.
- **Allarme trickle.** Contatore dei round REQUEST_CHANGES per PR: dal 3° round il messaggio Slack pinga l'owner — una decisione umana costa meno di un altro round da ~40 minuti.

### Changed
- **Review più leggera (contratto + comando).** Il default per codice funzionante e conforme alla spec è APPROVE-con-commenti: stile, naming, refactor minori ed edge case ipotetici non sono MAI bloccanti; i test sono richiesti solo su logica nuova non banale. La prima review deve essere **esaustiva** (tutti i blocchi al round 1 — il trickle è un difetto della review).
- **Testi sintetici e scansionabili.** La review sulla PR è: recap (2-4 frasi) → punti azionabili come bullet → **Da fare** in fondo; il comando impone al verifier rationale breve e follow-up a imperativi numerati. Template PR del contratto ridotto a Recap / Evidence / Deviations & open questions (il vecchio self-check resta come comportamento richiesto, non come boilerplate da incollare).
- Il comando `validate-pr` shipped è allineato al formato per-PR del verdict (`mergesmith-verdict-<pr>.json` + campo `pr`).

### Security (review multi-agente pre-release: 12 finding, tutti risolti)
- **Solo chi ha write/admin sul repo può rispondere a un NEEDS_DECISION** (`authorHasWriteAccess`, fail-closed): un account qualsiasi o un bot terzo che commenta la PR non decide per l'owner.
- **Le risposte dell'owner sono dati, non istruzioni**: `settledDecisions` decide solo la propria domanda; il comando vieta esplicitamente che una risposta alteri le regole di review (contenimento prompt-injection).
- **`cursor-agent` pre-pulisce anche il verdict per-PR**: un verdict stantio di una sessione crashata non può più essere applicato a uno SHA mai recensito (fail-open chiuso).
- **Delta della re-review calcolato contro l'head della PR** (`git diff <previousSha>..<headRefOid>`), mai contro l'HEAD locale del checkout condiviso.
- **Decisioni settled persistenti**: la risposta dell'owner sopravvive a tutti i round successivi (mai ri-chiedere una domanda già risposta), anche se arriva insieme a un nuovo push.
- **`askedAt` = `created_at` del server GitHub**: immune allo skew del clock locale nel poll delle risposte.

## [0.5.5] — 2026-07-10

### Fixed
- **409 `agent_archived` non è più "busy" → stop al loop infinito di re-verify con review duplicate** (#1). Cursor archivia l'agent pochi minuti dopo che ha finito; il follow-up di rework riceveva `409 agent_archived`, classificato come `busy` e ritentato a ogni tick — ri-eseguendo l'intera verify (~15 min) e postando una review CHANGES_REQUESTED duplicata, per sempre. Due fix:
  - **`providers/cursor.ts`**: il body del 409 viene discriminato — `agent_archived` → `POST /v1/agents/{id}/unarchive` + un solo retry (lo stesso agent conserva il contesto della PR); solo il resto dei 409 resta `busy`.
  - **Verify disaccoppiata dalla consegna del follow-up**: su fallimento retryable del follow-up (`busy`/`transient`) il verdetto viene persistito (`markReviewed` + `ReworkRecord` con `delivered:false`), così il tick successivo ritenta **solo la consegna** — mai la re-verify, mai la review duplicata. Se la consegna continua a fallire, il rework watchdog esistente fa da bound (TTL/idle → agent fresco via `adoptBranch`, poi needs-human).

## [0.5.4] — 2026-07-06

### Changed
- **Evidence policy: no screenshot merge gate.** `CONTRACT.base.md`, `SPEC_TEMPLATE.md`, and `validate-pr` now require automated test evidence (Vitest unit, component/render, integration) instead of screenshots. Missing screenshots must never block APPROVE.

## [0.5.2] — 2026-07-05

### Added
- **Il messaggio Slack di dispatch mostra il `title` della spec** come riga-riassunto "cosa stiamo costruendo" (riga 2), così il canale è scorribile senza aprire ogni spec. Idea di Marco.

## [0.5.1] — 2026-07-04

### Added
- **Reaction di stato "a colpo d'occhio" su Slack** (idea di Marco). Il messaggio radice della PR (il `:rocket: Dispatch`, che sta nella lista del canale) porta ora una **singola emoji di stato**, così scorrendo il canale si vede subito quali PR sono finite e quali no senza aprire il thread: ✅ mergiato · 🔄 rework · 🔴 CI rossa · ⚠️ needs-human · 🚨 stallo. Impostata a ogni transizione (`act.ts` + `tick.ts`), con remove-old + add-new così resta solo lo stato corrente. Nuovi `removeReaction` (slack.ts) + `setStateReaction` (thread.ts). Il thread continua a ricevere i messaggi come prima — la reaction è il riassunto visivo.

## [0.5.0] — 2026-07-04

### Added
- **mergesmith owns the branch (spec-in-branch dispatch).** `dispatch` ora crea un branch deterministico (`fm.branch`) dalla base **committandoci dentro la spec** (via GitHub Data API — `createBranchWithSpec`, nessun checkout locale), poi manda l'agent a lavorare su quel branch (`workOnCurrentBranch:true`) mentre Cursor apre la PR (`autoCreatePR:true`). Validato live (POC PR #123 + smoke test API). Elimina la precondizione "spec già su origin/base" + tutto l'attrito materialize/path. `branch` noto e `specSha` registrato da t=0.
- **Stall detection iniziale + auto-recover (`sweepDispatchStalls`).** Cattura il fallimento che prima era invisibile e manuale (agent finito senza aprire PR): run FINISHED + `branchHead === specSha` ⇒ no-op → re-dispatch sul branch (`adoptBranch`); committato ma senza PR ⇒ sollecito apertura; bounded (2), poi needs-human. Core decisionale puro e testato (`prGateAction`/`noOpRecovery`).

### Fixed
- **`mergeable == UNKNOWN` non è più needs-human.** Un APPROVE il cui auto-merge fallisce mentre GitHub sta ancora calcolando la mergeability veniva escalato a needs-human (falso, visto su #119). Ora ritenta al tick successivo. needs-human resta solo per fallimenti merge genuini / path critici / agent morto.

## [0.4.0] — 2026-07-04

### Added
- **Rework watchdog + auto-recover.** A REQUEST_CHANGES follow-up is now a tracked promise. The tick watches each rework PR: if the agent lands a new SHA it re-reviews; if the agent stalls (closes its run without pushing — `agentIdle` — or a TTL elapses) it auto-recovers by spawning a FRESH agent bound to the branch (`adoptBranch`), up to 2 attempts, then escalates to `needs-human`. Kills the silent-spin where the loop believed a stuck agent was working (the ramwms port pain).
- **`adoptBranch`** on the implementer provider — spawn a fresh agent on an existing branch (`workOnCurrentBranch`, no new PR). Also powers **`mergesmith followup --branch`** for a PR whose agent is dead/untracked (no more needs-human dead-end), and the REQUEST_CHANGES no-agent path.
- `agentIdle(ref)` — is the agent's latest run finished (done working)? The stall signal.

## [0.3.5] — 2026-07-04

### Changed
- **Dispatch messages anchor the PR thread.** The visible `:rocket: Dispatch` post in the channel is now the root of that PR's thread: the tick adopts it (by branch) the first time it sees the PR, so verdicts / rework / merge thread *under* the readable dispatch message. The channel reads as a clean log of what was launched; details are one click away.

## [0.3.4] — 2026-07-04

### Fixed
- **Cursor API calls retry transient failures in-call.** A flaky network (WSL/Tailscale) was dropping follow-ups/dispatches (`fetch failed`), leaving a PR stuck in rework — re-reviewed every tick (wasting a verifier run) without the agent ever receiving the instruction. `cursorFetch` now retries network blips / 429 / 5xx (3 attempts w/ backoff); a real 4xx (404, 409 busy) still surfaces immediately.

## [0.3.3] — 2026-07-04

### Fixed
- **Slack notifications survive a flaky network.** On WSL/Tailscale, transient `fetch failed`
  bursts were dropping Slack posts — and, because `threadedPost` wasn't guarded, the error
  propagated out and aborted the rest of the verdict application (no notification, and the loop
  logged `✗ PR #N: fetch failed`). Slack calls now retry transient failures (fetch failed / 429 /
  5xx, 3 attempts with backoff), and `threadedPost` is best-effort: a failed notification logs but
  never aborts the loop's GitHub work.

## [0.3.2] — 2026-07-03

### Changed
- **Merge conflicts self-heal instead of escalating.** An APPROVE that can't auto-merge because the
  PR conflicts with the base is agent-recoverable: the loop now sends the agent a rebase follow-up
  (`git merge origin/<base>` + resolve) and keeps it queued, instead of flagging `needs-human`.
  `needs-human` is reserved for genuine human calls — critical-path (CODEOWNERS) review, or a merge
  failure with no agent to fix it. New `prMergeable` github helper distinguishes CONFLICTING from
  other merge failures.

## [0.3.1] — 2026-07-03

### Fixed
- **Mode A follow-ups now resolve.** `refForBranch`/`knownBranches` searched only `runs`, so a PR
  dispatched via `dispatch --issue` (recorded in `issues`) was seen as "no known agent" → false
  needs-human + Slack ping on every REQUEST_CHANGES. Both now search `runs` AND `issues`.
- **Transient network errors during follow-up retry instead of escalating.** A `fetch failed` /
  429 / 5xx from the Cursor API while sending a rework follow-up was misclassified as permanent
  → needs-human. New `FollowupError` kind `transient` (matched by the cursor provider via
  `isTransientError`); `act.ts` + `tick.handleCiRed` retry it next tick like `busy`.

## [0.3.0] — 2026-07-03

### Added
- **Slack threading.** Every event about a PR (verdict, CI-red follow-up, merge, needs-human) now
  threads under one per-PR Slack message instead of flat-posting; mentions still fire only on
  events that need a human. `threadedPost` + a `pr→{ts,channel}` map in state.
- **Slack inbox (Slack → issue).** Discuss in a channel thread, an allowed user replies `!go`, and
  the tick synthesizes a clean GitHub issue (LLM one-shot on the verifier engine), creates it
  `ready`, reacts 👀→✅, replies in-thread with the link, and credits the reporter + finalizer.
  Opt-in (`slack.inbox.enabled`) + fail-closed allowlist; bootstrap cursor avoids flooding on
  historical `!go`; degraded synthesis falls back to a raw issue (flagged, never lost). New
  `mergesmith inbox` command; runs each tick.
- **Recap.** `mergesmith recap` posts a scannable snapshot — agent-managed PRs by state + issues by
  label — on demand; schedule a cron for a daily one.
- **`/mergesmith-issue` plugin command** — draft a `ready`/`needs-triage` work-issue from within a
  Claude Code session (the in-session complement to the inbox).

### Changed
- Slack read methods (`conversations.history`/`replies`, `users.info`) call the API form-encoded —
  Slack ignores a JSON body on those; `chat.postMessage` stays JSON for long text.

## [0.2.2] — 2026-07-03

### Fixed
- **Per-repo CLI lock.** Two concurrent `mergesmith tick`/verify runs on the same repo could race on
  `mergesmith-verdict.json` and the state JSON. An O_EXCL lockfile (stale-stolen after 45 min)
  serializes them; a second run logs and skips. Dry-run is exempt.

## [0.2.1] — 2026-07-03

### Added
- **Issue-completed automation.** When an APPROVE merge closes a tracked issue's PR into a
  non-default branch (no auto-close), the loop labels the issue `mergesmith:completed` and clears
  `in-progress`, so "done pending main" is legible.
- **Slack Web API foundation** — `postSlack` returns `{ts, channel}` and accepts `threadTs`;
  `readChannelHistory`/`readThreadReplies`/`getPermalink`/`addReaction` added (used by 0.3.0).

## [0.2.0] — 2026-07-03

### Added
- **Issues as work-source.** `mergesmith dispatch --issue <n>` (Mode A) and the tick auto-dispatches open issues labelled `mergesmith:ready` (Mode B). The implementer opens a PR that `Closes #N`; the verifier reviews against the issue when there's no `Spec:` field. Issue labels (`ready`/`in-progress`/`needs-triage`) created by `init`/`ensure-labels`.

### Changed
- `DispatchInput` now carries a prebuilt `prompt` (the orchestrator builds it for a spec OR an issue); the implementer just runs it.

## [0.1.9] — 2026-07-03

### Added
- **Kill switch** — `mergesmith pause` / `mergesmith resume` stop and restart the loop by
  writing/removing a `PAUSED` flag under `~/.mergesmith`, no crontab edit required. The tick
  short-circuits (skip) while the flag is present.
- **Health / heartbeat** — `mergesmith health` reports the target repo, pause state, and the
  age of the last successful tick. Each non-dry-run tick now writes a `heartbeat.json`
  (`lastTick` timestamp) per repo for dead-man's-switch checks.
- **`init` scaffolds `.github/workflows/ci.yml`** — a no-secret CI workflow whose job is named
  `ci` (the required status check the Mergesmith ruleset gates on), with `--if-present` steps so
  a fresh repo passes out of the box.

### Fixed
- **Multi-repo verifier `cwd`** — the verifier now runs in the target repo's local checkout via a
  new `VerifyInput.repoPath`, threaded from the repos registry through `tickAll` → `tickRepo`.
  Previously it always used `process.cwd()`, so in the multi-repo tick the reviewer could run
  against the wrong repository.

### Changed
- **Systemic tick-failure alert** — an uncaught error in a single-repo tick (e.g. an expired
  token making every call fail) now posts a `:rotating_light:` Slack alert (with mention) before
  rethrowing, instead of failing silently.

## [0.1.8] — 2026-07-03

### Added
- **`cursor-agent` verifier provider** — use Cursor Composer (`agent -p`) as the reviewer,
  inlining the command markdown as the prompt (`verifier.provider: cursor-agent`).

### Fixed
- **FAIL-CLOSED verdict validation** (shared `providers/verdict.ts`): a verdict that is missing
  or has a non-boolean `criticalPathHit` is now REJECTED — a critical-path PR can no longer slip
  past the human gate (previously fail-open). +6 unit tests.
- **No infinite re-review on APPROVE** — approve/auto-merge is wrapped so that when auto-merge
  isn't enabled or the PR isn't mergeable, the PR is flagged `needs-human` instead of re-running
  the full review every 20 minutes forever.
- **No @mention spam from dead agents** — on permanent follow-up failure (REQUEST_CHANGES and
  CI-red paths) the PR is marked reviewed + `needs-human` so it stops pinging every tick.
- **Tick skips `needs-human` PRs** — once a human owns a PR, pushes to it no longer trigger
  re-review or re-ping.
- **Atomic state writes** — `writeJson` writes to a temp file and renames, avoiding a truncated
  state file on crash or concurrent read.

## [0.1.7] — 2026-07-03

### Fixed
- Flag `needs-human` when the loop can't follow up: a PR that gets REQUEST_CHANGES or red CI but
  has no tracked implementer agent (legacy PR, or one opened outside `/dispatch`) is now labelled
  `needs-human` instead of being silently marked reviewed — no more invisible deadlocks.

## [0.1.6] — 2026-07-03

### Fixed
- Apply PR labels via the GitHub REST API (`issues/{n}/labels`) instead of `gh pr edit
  --add-label`, which exits 0 but silently no-ops (it queries the deprecated Projects-classic
  `projectCards` field via GraphQL).

## [0.1.5] — 2026-07-03

### Added
- `mergesmith init` now runs as the human admin's `gh` identity to: report the authenticated
  `gh` user (warning if not logged in), and apply the `mergesmith-main` branch ruleset via
  `gh api` (idempotent) — PR + code-owner review + status check `ci` + squash-only. It also
  creates the PR state labels. Remaining external-account steps (Cursor App install, bot
  collaborator, env, cron registration) are printed as manual instructions.

## [0.1.4] — 2026-07-03

### Added
- **`mergesmith dev-model [--list] [<model>]`** — get/set the implementer (Composer) model,
  symmetric to `verify-model`. The cursor provider can list `/v1/models`; overridable via the
  `MERGESMITH_IMPLEMENTER_MODEL` env var.

## [0.1.3] — 2026-07-03

### Added
- **`mergesmith ensure-labels`** — create the PR state labels idempotently.

### Fixed
- **Per-PR resilience in the tick** — `tickRepo` wraps each PR in try/catch so a transient
  fetch/`gh` failure on one PR no longer aborts the whole batch (found on the first live run).

## [0.1.2] — 2026-07-03

### Added
- First publish to the public npm registry (`@wmind/mergesmith`).
- Release workflow: any `v*` tag publishes to npmjs.org (dropped the GitHub Packages registry).

## [0.1.1] — 2026-07-03

### Added
- **Switchable review model** — `verifier.model` config + `MERGESMITH_VERIFIER_MODEL` env
  override → `claude --model`, plus `mergesmith verify-model [--list] [<model>]` to inspect and
  switch the review model.
- **Attribution** — the `Verdict` carries `{engine, model}`, rendered in the review body and
  Slack; `dispatch` also names the implementer engine/model.

### Fixed
- **Robust verdict delivery** — the command now writes a fixed `mergesmith-verdict.json` in the
  cwd and the provider reads it back from there, instead of relying on `$MERGESMITH_VERDICT`
  (the review sandbox blocks env-var reads). Fixes "no verdict produced" on every PR.

## [0.1.0] — 2026-07-03

### Added
- Initial scaffold of the Mergesmith agent-workflow framework: the rambase
  spec → implement → verify → merge loop extracted into a reusable, provider-agnostic framework
  (`@wmind/mergesmith` npm package + Claude Code plugin).
- Pluggable `ImplementerProvider` (Cursor) and `VerifierProvider` (Claude Code), selected from
  `mergesmith.config.json`.
- Thin verifier: emits a structured `Verdict`; the orchestrator (`act.ts`) does
  approve / merge / follow-up / labels / Slack in one provider-neutral place.
- CLI: `init`, `dispatch`, `tick [--all] [--dry-run]`, `followup`, `notify`, `mark-reviewed`.
- PR labels reflecting loop state (`mergesmith` / `mergesmith:ci-red` / `:rework` /
  `:needs-human` / `:approved`).
- CI without secrets, config-driven state under `~/.mergesmith`, 12 tests green.

[0.1.9]: https://github.com/wmindsrl/mergesmith/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/wmindsrl/mergesmith/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/wmindsrl/mergesmith/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/wmindsrl/mergesmith/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/wmindsrl/mergesmith/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/wmindsrl/mergesmith/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/wmindsrl/mergesmith/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/wmindsrl/mergesmith/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wmindsrl/mergesmith/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wmindsrl/mergesmith/releases/tag/v0.1.0
