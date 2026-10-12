### Perf issue

Tie every fix to a measurement. Do not read source in place of measuring.

1. Capture a baseline trace on the real surface.
2. Run the how skill to ground hypotheses. Do not claim a ceiling you have not measured. Use these strategy families to generate hypotheses, and try one only when the trace shows its signal.
   - Elimination removes work nobody needs. The trace cannot show that work is deletable, so this one needs the how pass.
   - Divide and conquer splits work whose cost grows with input size, or runs independent pieces in parallel.
   - Caching reuses results for repeated identical inputs. Name what invalidates the cache.
   - Indirection adds an index, queue, or handle only when it removes more from the hot path than it adds.
   - Batching merges many small operations that each pay a fixed overhead.
   - Redundancy duplicates a slow request and takes the fastest result, when the wait dominates and the system has headroom.
   - Lazy evaluation defers work until first use.
   - Scheduling moves needed work out of the interactive moment, earlier or later. Measure the interactive path.
3. Plan the fix from the trace. Use the architect skill if it crosses a function boundary. Delegate the change, using the perf-issue role from the model policy in Subagents, and review the diff. Try one change at a time.
4. Capture a post-fix trace and compare the artifacts, for example by loading both into sqlite. An inconclusive result or a different surface is not a pass.
5. Cite the measurement in the commit or PR, then run `playbooks/opening-a-pr.md`.

For sustained work on one metric, use `playbooks/hillclimb.md`.

Reply with the baseline number, the post-fix number, the delta, and the artifact path.
