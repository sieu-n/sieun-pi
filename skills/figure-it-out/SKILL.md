---
name: figure-it-out
description: "Design an auditable playbook when no narrower one fits: a large migration, an ambitious multi-part change, or work a human reviews after stepping away. Scales rigor to the task, runs a hypothesis loop, and logs decisions via show-me-your-work. Use for `figure-it-out`, 'figure it out', a large migration, or when no narrower playbook applies."
disable-model-invocation: true
---

# Figure it out

Before you spawn workers, read `../setup-pstack/references/prime-agent-runtime.md` for the spawn, report, and depth-limit contract. Take models from `~/.prime/agent/pstack-models.json`.

Design the workflow before you write code. The workflow is a list of phases that scales rigor to the task and leaves a decision trail a human can audit later. When unsure how much rigor to use, use more.

A focused task that matches a poteto-mode playbook (Bug fix, Perf issue, Feature, Visual parity, Eval, Multi-phase plan) goes to that playbook. A large or cross-cutting version of one, or work the user reviews after stepping away, stays here.

## Start

Write a checklist. Its first item is to read the Principles section of the **poteto-mode** skill. Add phases A to E as the next items.

## Phase A: Frame

Do not start the run until you can state these three things.

- The definition of done is a falsifiable predicate, per principle-prove-it-works.
- The scope is counted in units and effort, and it lists the blockers you found while reading the code.
- The rigor level is set high for one-way doors and wide impact, and lower for reversible low-stakes steps.

Rigor means gates and artifacts. Present the framing and tradeoffs before a run of more than an hour. Reversible work proceeds without waiting, per principle-never-block-on-the-human.

## Phase B: Design the workflow

Split the work into units that can each land alone. Put the riskiest unknown first. Build scaffold and verification before features, per principle-foundational-thinking.

- Build the verification harness before the work, and capture the baseline from the pre-change state.
- Run the **architect** skill for one-way-door design decisions, and skip it for mechanical work whose shape is already clear.
- Fan out only across real seams, and give each worker its own worktree or branch, per principle-separate-before-serializing-shared-state.
- Write the phase list down, because it is what the human reviews.

Add the designed steps to the checklist after Phase C and before Phase D. Run each step under the Phase C loop. Add a Phase D log row as each step lands.

## Phase C: Run the loop

Treat each unit as an experiment. State the hypothesis, make the smallest change, and measure it against the predicate on the real artifact. Keep the change if it moved the predicate, and revert it if not. Verify each unit before the next, per principle-sequence-verifiable-units.

- Suspect the check first when something passes too easily, since a blank screenshot passes a lazy gate.
- Audit each worker's artifacts yourself before you trust its report.
- Reset and tighten the brief when a worker games the gate.
- Fix a wrong gate in its own change, and never route around it.
- Mark each verdict VERIFIED, NOT VERIFIED, or INCONCLUSIVE, and count INCONCLUSIVE as a fail.

## Phase D: Keep the audit trail

Log the run with the **show-me-your-work** skill. Commit the trail when the reviewer needs to see the evidence in the PR. Produce evidence with committed scripts so a reviewer can rerun them.

## Phase E: Verify and hand back

Check the whole result against the Phase A predicate on the real product. Turn each repeated correction into a gate, lint rule, check, or script, per principle-encode-lessons-in-structure.

The reply names the playbook you designed, the rigor level and the reason for it, the decision-trail path, what passed against the predicate, and what is still open.
