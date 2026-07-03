---
name: mergesmith-issue
description: Turn a request into a well-formed Mergesmith work-issue (GitHub issue the loop can dispatch)
---

# File a Mergesmith work-issue

Argument (`$ARGUMENTS`): a free-text description of the bug or feature. If empty, ask the user
what they want done — one focused question, not a form.

Turn the request into a **clean, implementable GitHub issue** that the Mergesmith loop can pick
up and dispatch to the implementer. This is the in-session complement to the Slack inbox (which
does the same from a `!go`-finalized thread).

## Steps

1. **Read the config**: get `repo` and the issue labels from `mergesmith.config.json` in the repo
   root (fields `repo`, `issues.ready`, `issues.needsTriage`). If the file is missing, stop and
   tell the user to run `mergesmith init` first.
2. **Understand the request against the codebase.** Look at the files/areas it touches so the
   issue is concrete (exact paths, the current behaviour, the desired behaviour). Do NOT start
   implementing — this command only writes the issue.
3. **Draft the issue** with:
   - **Title**: concise, imperative (e.g. "Sposta il link WMS in cima al side-menu").
   - **Body** (markdown, in the user's language): *Contesto* (what/where today), *Cosa fare*
     (the change), *Criteri di accettazione* (checkable list). Reference concrete paths.
   - A footer line crediting the source: `_Richiesta da <user>, redatta in sessione Claude Code._`
4. **Show the drafted title + body to the user and get explicit approval.** Do not create the
   issue until they confirm. Offer them the label choice:
   - `ready` (default) → the tick dispatches it automatically to the implementer.
   - `needs-triage` → parked; someone promotes it to `ready` later.
5. **Create it** with the human's gh auth (default, not the bot token):
   `gh issue create --repo <repo> --title "<title>" --body "<body>" --label <chosen-label>`
6. Report the created issue number + URL. If the label is `ready`, remind that the next tick
   (`mergesmith tick --all`, cron) will dispatch it; for an immediate dispatch:
   `mergesmith dispatch --issue <number>`.

If any command fails, report the error text as-is (it is already explicit) and do NOT retry with
changed parameters on your own.
