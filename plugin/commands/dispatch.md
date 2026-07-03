---
name: dispatch
description: Send a Composer-ready spec to the implementer via Mergesmith
---

# Dispatch a spec

Argument: path to the spec (e.g. `docs/specs/2026-01-01-thing-design.md`).

1. Verify the spec is committed and pushed to its `base` (`git status` clean for that file; `git log origin/<base> -- <path>` non-empty). If not, commit + push first.
2. Run: `mergesmith dispatch $ARGUMENTS`
3. Show the output (agent id, branch, PR if already known) and remind that the return is handled by the tick (`mergesmith tick --all`, cron): the review starts on its own once the PR is ready with green CI. For an immediate review: `/validate-pr <number>`.

If the command fails, report the error text as-is (it is already explicit) and do NOT retry with changed parameters on your own.
