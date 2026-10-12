### Multi-phase or multi-PR plan

For work that spans phases or several PRs. The plan is the deliverable, so do not implement. An owner runs it box by box, and the operator audits it from the evidence.

1. If the change is one or two files with an obvious approach, say so and stop.
2. Settle open questions with `playbooks/prototype.md` before you write. Keep the branch, SHA, and screenshots for Appendix A. Ask the operator only about product or preference calls, and offer options.
3. Explore in subagents briefed with the poteto-agent skill, using the models from the Subagents section of `SKILL.md`. Each returns file pointers, conventions, test commands, and entry points.
4. Copy the skeleton below into the plan file and fill every placeholder. Unless the operator names a path, write it under the agent's artifact folder. Keep every heading and sub-block in order, with one section per PR. Name the execution playbook in How to read this, usually `playbooks/orchestrate.md` or `playbooks/autonomous-run.md`.
5. Write it with the unslop skill. The body is a how-to, and the appendices hold explanation and reference. Each heading names the task or the finding.
6. Set the source variables from `SKILL.md`, then run `node "$POTETO_MODE_DIR/scripts/check-plan.mjs" <plan.md>` through Prime's `bash(...)`. Fix every line it prints. It checks the skeleton, the verification rule in each verification block, and punctuation.
7. Post the plan path and the script output, then stop. Execution starts on the operator's explicit go.

Every verification block opens with the rule that the skeleton repeats. The live block is required, with ten lanes at the PR head that drive the real surface per the swarm skill. Each lane names a scenario, the screenshot it saves, and its pass condition. The perf block names the metric, the probe, the trunk baseline measured first, and the failing threshold. A PR that changes an interaction waits for the operator's review with screenshots and a video. A PR that changes none writes `**Review gate.** None. <PR id> is not review-gated.` with no boxes under it.

Pick the control surface per PR. Use the aside-browser skill for anything in a browser and Prime's `bash(...)` for CLIs and TUIs. A PR that touches two surfaces gets lanes on both. A surface with no way to drive it is a risk in Appendix C.

````markdown
# <Program> plan

<Under ten lines. What changes, for whom, the rule the program enforces, and the PR ids in order.>

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `$POTETO_MODE_DIR/playbooks/<execution playbook>.md`. <Who merges, and which PR ids stop at merge-ready for the operator.>

In the Prime Python REPL, set `os.environ["POTETO_MODE_DIR"] = "<absolute poteto-mode source directory>"` and `os.environ["POTETO_SKILLS_DIR"] = "<absolute sibling skills directory>"`. Import `os` first. Run the shell commands below through Prime's `bash(...)` from the target project. These paths name the active skill sources, not files in the target project's trunk.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On that go, arm a `/goal` through the goal skill with this exact text. "<The plan path, the PR ids in order, the verification rule, who merges, and the done condition.>"
- [ ] Read these active skill sources at program start. Re-read them at every tick.
  - [ ] `cat "$POTETO_MODE_DIR/playbooks/<execution playbook>.md"`
  - [ ] `cat "$POTETO_SKILLS_DIR/swarm/SKILL.md"`
  - [ ] `cat "<absolute control skill SKILL.md path from Prime's skill listing>"`
  - [ ] `cat "$POTETO_MODE_DIR/playbooks/opening-a-pr.md"`
  - [ ] `cat "$POTETO_SKILLS_DIR/<each other bundled leaf skill>/SKILL.md"`
- [ ] Arm the 30-minute audit tick as an `rlm-heartbeat` entry.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from its active skill source and the armed /goal. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then send the operator a status message, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] <PR id> and <PR id> are independent and first. Both branch from `main`.
  - [ ] <PR id> after <PR id>.
- [ ] Hold the file boundaries. <PR id or class> touches only `<glob>`.
- [ ] Hold the review gate. <PR ids> change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Ship each PR per `$POTETO_MODE_DIR/playbooks/opening-a-pr.md`.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `unslop` over prose and `no-comments` over code before each commit.
- [ ] Triage every review-bot comment per `$POTETO_MODE_DIR/playbooks/babysit.md`.
- [ ] Rebase onto current trunk before babysit and again before the merge-ready report.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, run the swarm per `$POTETO_SKILLS_DIR/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head gets a fresh swarm and a fresh verdict.
- [ ] After any rebase, compare `git patch-id` at the verdict SHA with the new head. Re-verify if it changed.
- [ ] <The merge rule from the execution playbook.>

### Boot recipe, for every live lane

Each live lane runs as its own RLM child in its own git worktree at the PR head. It drives the surface with the `aside-browser` skill or Prime's `bash(...)`.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] <Start the backend and the surface. Wait for ready.>
- [ ] <Deliver input only through the control skill's commands. Name the read-only diagnostics.>
- [ ] Save every screenshot to `<artifact dir>/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## <Task as a verb phrase> (<PR id>)

**Depends on.** <PR id, or None.>

**Files.**

- [ ] Edit `<path>`.
- [ ] Create `<path>`.
- [ ] Delete `<path>`.

**Build.**

- [ ] <One change. Name the symbol and the file.>

**You see.**

- [ ] <One observable result, with the exact log line or screen state.>

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] <Test file and the case it gains.> Run `<command>`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head using the configured verifier role, per the boot recipe.

- [ ] Lane 1. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 2. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 3. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 4. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 5. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 6. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 7. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 8. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 9. <Scenario.> Save `<slug>.png`. Pass when <predicate>.
- [ ] Lane 10. <Scenario.> Save `<slug>.png`. Pass when <predicate>.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. <What is measured.>
- [ ] Probe. <The command or procedure, run at trunk and at the head, interleaved.>
- [ ] Baseline. Record the trunk <value> first.
- [ ] Rule. <Head against trunk, with the number that fails.>

**Review gate.** The operator reviews before merge.

- [ ] Copy lane <n> screenshots into `<media path>/<pr-id>-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change. Save it as `<media path>/<pr-id>-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] <Who merges this PR, and how.>

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

<Each open question a prototype answered, with the branch, the SHA, and the artifact links. Each question that stays unproven.>

## Appendix B. Alternatives rejected

<Each approach weighed and why it lost.>

## Appendix C. Risks

<Each risk with the PR it lands in and what the owner watches.>

## Appendix D. Links and reading list

<Docs to read before editing. Which PRs get `$POTETO_SKILLS_DIR/how/SKILL.md` and `$POTETO_SKILLS_DIR/interrogate/SKILL.md`. The trail per `$POTETO_SKILLS_DIR/show-me-your-work/SKILL.md`.>
````

Reply with the plan path, the PR ids with dependencies and the review-gated set, what the prototypes proved and what stays unproven, and the check script output.
