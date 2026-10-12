### Hillclimb

For "hillclimb on X", "make startup 50% faster", or "keep trying until the metric improves by N%". Make one change, take one measurement, then keep or revert. Never stack untested changes, and never claim a win from reading code.

1. Run the how skill over the target and pick a workload that reproduces the user's complaint. If none does, fix the repro first. Fix one metric, its better direction, and a stop predicate that pairs a target with a minimum number of attempts, such as "at least 50% better and at least 10 iterations".
2. Build the measurement harness with principle-build-the-lever. Show that it separates the slow case from easier ones, then freeze it. One command must emit the metric as a median of several runs. Record the baseline and a green run of the regression tests before any change.
3. Open a `decision.tsv` log with the show-me-your-work skill, with one row per attempt holding id, hypothesis, change, before, after, delta, tests, verdict, and note. Keep it out of git so reverts do not touch it. Read it before each attempt.
4. Tie each hypothesis to a named mechanism, such as "defer X off the boot path because it blocks first paint".
5. Run one hypothesis per iteration.
   - Hand the change to a subagent, using the hillclimb role from the model policy in Subagents, and review its diff. Run independent hypotheses in parallel subagents, each in its own worktree.
   - Measure before and after with the frozen harness, and run the regression tests.
   - Keep the change only if the metric moves past noise and the tests stay green. Otherwise revert all of it.
   - Commit each kept fix with only its files (`git add <files>`, never `-A`). Log the row either way.
   - For an unattended run, take the wake from `playbooks/autonomous-run.md`, but use this playbook's stop rule.
6. On a plateau, change category, combine near-misses, or try a bolder idea. Revert a win that breaks behavior. Keep a simplification that holds the number.
7. Stop when the predicate holds, or when the remaining ideas cost more than they could gain. Do not relax the predicate.
8. Run `playbooks/opening-a-pr.md` with the kept commits in the order they landed.

Reply with the metric and target, baseline and final values with the percent change, iterations kept and reverted, one line per kept fix, the `decision.tsv` path, and the next idea you would try.
