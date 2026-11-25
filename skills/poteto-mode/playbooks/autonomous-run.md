### Autonomous run

For "going to bed", "run until done", and "run until X".

1. Write the exit condition as a checkable predicate before the first iteration, such as tests green, repro fixed, or pixel diff zero.
2. Pick the wake. Wait with `board.wake` and end the turn (config/AGENTS.md rule 6): `board.wake(run=<id>)` for a CI run, `board.wake(check="<shell command that exits 0 once it happened>", at=<deadline>)` for an event such as a merge or a unit ending, and `board.wake(at=<time>)` for a timer. Only a session with no board arms an rlm-heartbeat (`await rlm_heartbeat.create(instruction, interval='30m', label='...')`).
3. In each iteration, make the smallest change the evidence supports, check it against the predicate, and commit it if the predicate moved. Revert changes that did not help.
4. Fix what you find on the way, such as broken skills, related bugs, flaky checks, and tooling failures, in separate commits. Then return to the predicate. Stop to ask only for an irreversible action, a product call no experiment can settle, or a real dead end.
5. Log every iteration with the show-me-your-work skill, with what changed and whether the predicate moved.
6. Stop when the predicate holds. On a plateau, change approach and keep going. Never relax the predicate to declare success.

Reply with the exit condition, iterations run, what landed, what you reverted, and the final predicate state.
