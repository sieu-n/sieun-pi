---
name: poteto-mode
description: "Work in poteto's style, with concise detailed replies, deliberate subagents, plain prose, simple code, and verified work. Use when the user says poteto or poteto-mode, or asks to work in this style. Apply it to a new task that matches a playbook or needs rigor. Skip it for a casual turn or when the user opts out."
disable-model-invocation: true
metadata:
  icon: crown
  color: yellow
---

# Poteto mode

## Source paths

Take the absolute directory of this `SKILL.md` from Prime's skill listing and set two variables in the Python REPL before you run a playbook command.

```python
from pathlib import Path
import os

poteto_mode_dir = Path("<absolute poteto-mode skill directory>").expanduser().resolve()
os.environ["POTETO_MODE_DIR"] = str(poteto_mode_dir)
os.environ["POTETO_SKILLS_DIR"] = str(poteto_mode_dir.parent)
```

Paths that start with `playbooks/`, `references/`, or `scripts/` are relative to this skill directory. Paths that start with `../` are relative to the file that names them. Other skills are siblings under `$POTETO_SKILLS_DIR`.

Run shell commands through Prime's `bash(...)` from the target project, which inherits these variables. An example is `bash('bun "$POTETO_MODE_DIR/scripts/watch-pr/watch-pr" --status-only')`. Pass the absolute paths to children and to written plans.

## Non-negotiables

Start every multi-step task with a written checklist. Its first item is to read the Principles section in full. Prime has no todo tool, so keep the checklist in your reply or in a scratch file. In the reply, name each principle that changed a decision and the choice it changed.

- Use the how skill for a nontrivial change, an architecture decision, or an "are we sure?" question.
- Before you ask the user which approach to take, check whether running something would answer it. If it would, settle it with `playbooks/prototype.md`. Ask only about a product or preference call that no experiment can settle. A read-only Investigation answers from evidence and does not build a sketch.
- Name the data shape before you write code, and pick its structure with principle-model-the-domain.
- Use the architect skill before code that crosses a function boundary.
- Use the swarm skill for coverage fan-out and the arena skill for design or code bakeoffs.
- Write the throughput checkpoint from Feature step 3 for nontrivial multi-step work.
- Apply the unslop skill to every prose surface, including the reply, docs, commits, and PR bodies. Agent-facing prose also follows Prime's skill-creator skill.
- Run the no-comments skill over the diff before you commit.
- Drive the real surface yourself. Use the aside-browser skill for anything in a browser and `bash(...)` for CLIs and TUIs.
- Fix a broken skill in its own commit when you hit it, and keep going.
- Keep a decision trail with the show-me-your-work skill for long, autonomous, or multi-phase work, or work the user will review later.

## Principles

Read the leaf skill in full for any principle you apply.

| Principle skill | Apply when |
|---|---|
| principle-laziness-protocol | You size a diff or want to add a layer. Prefer deletion and the smallest change that works. |
| principle-redesign-from-first-principles | A new requirement lands on an old design. Design as if it had been there from day one. |
| principle-experience-first | You weigh product, UX, or scope. Pick what the user sees over what is easy to build. |
| principle-build-the-lever | Work is non-trivial. Build the script, codemod, or generator that does or proves it. |
| principle-model-the-domain | Logic holds state or branches a lot. Encode it in a state machine, typed model, table, or reducer. |
| principle-boundary-discipline | You wire validation, errors, or adapters. Guard at system edges and trust internal types. |
| principle-type-system-discipline | You design types or a signature. Make illegal states unrepresentable and parse external data at edges. |
| principle-make-operations-idempotent | A command or loop runs through crashes and retries. Make it converge to one end state. |
| principle-migrate-callers-then-delete-legacy-apis | A new API replaces an old one. Move every caller and delete the old API in one wave. |
| principle-separate-before-serializing-shared-state | Concurrent actors may write the same file, branch, or key. Remove the sharing first. |
| principle-prove-it-works | You are about to call a task done. Check the real artifact, not a proxy. |
| principle-fix-root-causes | You debug. Reproduce first and trace each symptom to its cause. |
| principle-sequence-verifiable-units | Work has many steps. Cut it into small units that each end in a check. |
| principle-guard-the-context-window | Output, files, or fan-out planning are large. Send bulk to subagents and keep summaries here. |
| principle-encode-lessons-in-structure | You write the same instruction twice. Turn it into a lint, check, flag, or script. |

## Autonomy

Proceed without asking on reversible work and on external actions such as team chat, ticket updates, and eval runs.

Pause before irreversible writes, which include force-pushes to shared branches, deploys, data deletion, and messages to customers.

"Don't stop", "going to bed", and "run until done" mean keep going.

When asked whether to do something, give your real judgment. Decline or push back when the idea does not pay for itself.

## Subagents

Prepend the poteto-agent skill to the brief of any subagent you spawn in a playbook step. Routed skills such as how, why, and swarm set up their own children, so follow them as written.

Spawn with `handle = await rlm.spawn(brief, name=...)`. End every brief with `await agent_message.send(report, receiver_role="parent")`, because the spawn call never returns the child's answer. Read `../setup-pstack/references/prime-agent-runtime.md` before you fan out, and check `RLM_MAX_DEPTH`. At the ceiling, do the work inline.

Pass file pointers, not pasted context. Omit `model=` and `thinking=` unless `~/.prime/agent/pstack-models.json` names a model for the role. The repo default for that file is `config/pstack-models.json`, and the setup-pstack skill changes it.

You own every child's work. Read its diff and write your own summary. To change a child's scope, spawn a fresh child with the full scope rather than chaining follow-ups. A second opinion is the same prompt on a different model.

## The reply

Write the reply with the unslop skill as you draft it. Keep every section the playbook's Reply line names. Say who the work is for and what changes for them, then what the next maintainer inherits. Link only artifacts you made or read this session.

## Playbooks

Copy the matched playbook's steps into your checklist before you plan anything else. A step you skip stays in the list as `skip: <reason>`.

Route a large or cross-cutting effort, or work the user will trust later without watching, to the figure-it-out skill, even when Feature fits. Use figure-it-out when no playbook below fits. A standing program with many subagents under one coordinator goes to Orchestrate.

| Playbook | Use it for | File |
|---|---|---|
| Investigation | A read-only question about how, why, or which option. | `playbooks/investigation.md` |
| Bug fix | A defect to reproduce, root-cause, and fix. | `playbooks/bug-fix.md` |
| Perf issue | A one-off slowness to fix against a baseline. | `playbooks/perf-issue.md` |
| Hillclimb | A loop that drives one metric to a target. | `playbooks/hillclimb.md` |
| Runtime forensics | A diagnosis from live instrumentation. | `playbooks/runtime-forensics.md` |
| Trace forensics | A diagnosis from a captured profile, trace, or heap snapshot. | `playbooks/trace-forensics.md` |
| Feature | New or changed behavior. | `playbooks/feature.md` |
| Refactoring | A change to structure that keeps behavior. | `playbooks/refactoring.md` |
| Prototype | A throwaway sketch that settles a design or empirical question. | `playbooks/prototype.md` |
| Visual parity | Pixel-exact UI equivalence. | `playbooks/visual-parity.md` |
| Authoring a skill | Writing or editing a SKILL.md. | `playbooks/authoring-a-skill.md` |
| Eval | A blind test of a skill or prompt change. | `playbooks/eval.md` |
| Babysit | Driving an open GitHub PR to merge-ready, on request. | `playbooks/babysit.md` |
| Autonomous run | One long task driven to a predicate. | `playbooks/autonomous-run.md` |
| Orchestrate | A multi-day program run by one coordinator. | `playbooks/orchestrate.md` |
| Session pickup | Taking over a prior agent's work. | `playbooks/session-pickup.md` |
| Pause safely | A clean stop that a later agent can resume. | `playbooks/pause-safely.md` |
| Multi-phase plan | A written plan for work that spans phases or PRs. | `playbooks/multi-phase-plan.md` |
| Worktree cleanup | Pruning old worktrees and simulators to free disk. | `playbooks/worktree-cleanup.md` |
| Shipping the change | The last step of every other playbook. | `playbooks/opening-a-pr.md` |
