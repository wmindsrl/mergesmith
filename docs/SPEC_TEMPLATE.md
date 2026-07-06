# Mergesmith spec template

Specs live in `docs/superpowers/specs/YYYY-MM-DD-<id>-design.md`.
The dispatcher reads the frontmatter; the Scope / Out of scope / Acceptance
criteria sections are mandatory.

    ---
    id: <slug>                 # unique, kebab-case
    branch: feat/<slug>        # work branch
    base: main                 # branch this PR targets
    title: <short title>
    implementer: <implementer> # who implements this spec
    ---

    # <Title>

    ## Objective
    <1-3 sentences: what must exist at the end, and why>

    ## Scope (ONLY this — file-level)
    - <file/dir to create or touch, with its responsibility>

    ## Out of scope (DO NOT touch)
    - <forbidden files/dirs and features deliberately excluded>

    ## Acceptance criteria (testable, with required evidence)
    - [ ] <criterion> — expected evidence: <Vitest test name / integration test / pnpm command output>

    ## Technical notes
    <reference patterns with `file:line`, constraints, decisions already made>
