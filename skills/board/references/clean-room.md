# Clean-room runs

Read this before you call a harness, skill or tool change done. The owner's rule c84 says a change is done only when a clean session, run by the system with nobody stepping in, shows the intended behavior and a file records the pass.

The lever is `components/user-history/scripts/clean-room/clean-room.ts` in sieun-pi. It makes a throwaway test chat through the chat server's own routes, seeds it from a copy of a real state, lets the server run it, saves the evidence and judges it. `checkin-goal-push.ts` next to it is the first scenario and the model for the next one.

## Run one

1. Write the criteria first in `~/.prime/agent/clean-room/<change>/criteria.md`, before any run starts. Each line says what a person would see when the change works and can be checked from session files, the board, the duty runs or the Prompt view captures. Add a line that the run touched no real system and one that nobody stepped in.
2. Save the real state you copy, such as a chat's board from `~/.prime/agent/browser-chat/boards/`.
3. Add a scenario file next to `checkin-goal-push.ts` with the seeds (the head's message, fixture jobs, the board change) and an evaluator that reads each criterion. Register it in `SCENARIOS` in `clean-room.ts`.
4. From `components/user-history`, run `node --import tsx scripts/clean-room/clean-room.ts setup --scenario <name> --criteria <criteria.md> --board <copy> --name "Clean room <change> <date>" --every-min <n> --run <run folder>`.
5. Start `clean-room.ts collect --run <run folder> --until <ISO time>` detached with `nohup`, set `board.wake(at=...)` for the end of the window, and end your turn.
6. Leave the test chat, its jobs and its board alone until the window ends, and never trigger a run by hand.
7. Run `clean-room.ts evaluate --run <run folder>`, which writes `<run>.pass.md`, `<run>.fail.md` or `<run>.void.md` next to the run folder.
8. On a fail, send the failing criteria with their evidence quotes to the job that owns the change. After its next release, run setup again with a new run folder.
9. Run a void run again as it is, because the system did not get a fair window, the test touched something real, or someone stepped in.
10. After the pass, run `clean-room.ts teardown --run <run folder>`, which archives the test chat and every job it had through the chat server's archive route.

## Keep the copy faithful and safe

1. The test chat works in a sandbox folder whose `AGENTS.md` tells every session there that it is a dry run.
2. Every owner on the copied board points at a fixture job that only logs what it gets, so no test session can read or message a real job.
3. The run's `setup.md` lists each change from the real state and why, so a reader can judge the copy.
4. A short check-in interval is fine on the throwaway chat because c84 asks for the run, and a real chat's interval never changes for a test.
5. A fixture job created through `POST api/threads` starts even while the fleet budget is shut, but the check-in's duty job and the jobs it starts wait their turn there like any other start.
