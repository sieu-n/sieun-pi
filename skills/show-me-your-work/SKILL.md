---
name: show-me-your-work
description: "Keep a decision trail a reviewer can check after long, unattended, or multi-phase work. The trail is a TSV log with one row per decision: what, why, evidence, and result. Use for `show-me-your-work`, autonomous or multi-phase runs, or work a human reviews after stepping away."
disable-model-invocation: true
---

# Show me your work

Keep one TSV decision log per run, so a reviewer can see what you decided, why, and on what evidence without reading the transcript.

## Format

Start the log from `references/decision-log-template.tsv`, which holds the header row. Each cell stays on one line.

- `ts` is the UTC ISO 8601 timestamp.
- `phase` names the phase or workstream.
- `decision` says what you chose or did, in one line.
- `why` gives the reason in plain words, such as `explored options first, this was a one-way door`.
- `evidence` points at proof: a commit SHA, PR number, `file:line`, or an artifact, trace, or screenshot path, never a paragraph.
- `result` gives the outcome, such as `tests green`, `reverted`, `pixel-diff 0`, `INCONCLUSIVE`, or `open`.

Rows read like this:

```
ts	phase	decision	why	evidence	result
2026-05-24T09:40:00Z	harness	took screenshots of the old version before changing anything	so we can compare old against new	scripts/snapshot.sh, baseline/	saved 120 reference screenshots
2026-05-24T12:30:00Z	widget	threw out a helper's work because its screenshots were blank	checked the real files instead of trusting its summary	worktree reset	reverted, tightened the helper brief
```

## Logging a row

Append rows with `scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result>`. The script stamps `ts`, writes the header on first use, replaces tabs and newlines with spaces, and puts a single quote before any cell that starts with `=`, `+`, `-`, or `@` so a spreadsheet does not run it as a formula. If you append with `printf` instead, clean the same bytes yourself.

Write each row the way you would tell a teammate what you did, and follow the `unslop` skill. Log decision points and checkpoints: a fork chosen, a unit finished with its verification result, a pivot or revert with its trigger, a blocker, a gate fixed. In a loop, log one row per iteration. Skip trivial steps.

## Rules

- One row holds one decision, and a decision that does not fit on one line is not clear yet.
- The log is append-only, so a wrong call gets a new row that replaces it.
- Evidence from committed scripts beats one-off checks, because a reviewer can run it again (see `../principle-encode-lessons-in-structure/SKILL.md`).

## Where it lives

Keep the log at `decisions.tsv` in the work directory, or at `.audit/<task-slug>.tsv` when several efforts run at once, and leave it out of git. Commit it only when a reviewer needs the trail to trust the result, such as a large cross-language port or a multi-week migration. GitHub renders a committed TSV as a table, and `column -s$'\t' -t decisions.tsv` renders it in a terminal.

## Audit the log against the transcript

Before you hand back, read this run's transcript at the `Conversation log:` path in your system prompt. Do not read other sessions under `~/.prime/agent/sessions/`.

- Cut any row that does not match a real action.
- Check that each row's evidence resolves and shows what the row claims.
- Add a row for any fork, pivot, or abandoned approach that shaped the work but is missing.
- Cut rows nobody would audit.

If the work differs from a row, fix the row.

## Cross-model review

Before you hand back, spawn a reviewer on a different model family than the one that did the work. Pick its model from the `allowed` list in `~/.prime/agent/pstack-models.json` (repo default `config/pstack-models.json`). The reviewer reads the log and the transcript and flags what the user should check:

- It flags decisions with weak or missing evidence.
- It flags verification steps that the transcript does not show.
- It flags choices that look risky now, such as premature work, scope creep, or a fix that hides a symptom.
- It flags gaps the user would miss on a quick read.

End every reply for a run with a trail in an "Attention" section. Its first line is `reviewed by <model>`, and the flags follow, each pointing at specific rows or moments. "No flags" is a valid list. The model name is required.

Other skills that need an audit trail point here and do not restate the columns.
