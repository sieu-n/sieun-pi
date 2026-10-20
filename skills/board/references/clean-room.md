# Clean-room runs

Read this before you call a harness, skill or tool change done. The owner's rule c84 says a change is done only when a clean session, run by the system with nobody stepping in, shows the intended behavior and a file records the pass.

The lever is `components/user-history/scripts/clean-room/clean-room.ts` in sieun-pi. It opens a chat through the chat server's own routes, lets the server run it, saves the evidence and judges it. `checkin-real-task.ts` next to it is the model scenario: a fresh chat with one ordinary owner-style message and nothing seeded.

## Never tell it

A clean-room chat gets a real, ordinary task and never learns it is a test. Its first message reads like the owner's ("research which of our instagram index gaps matter most and keep a page with the top 10 updated"), its name is a plain one he would pick, and no board item, todo, job name, note or AGENTS.md says test, twin, fixture or clean room. On 10-15 the first run told its chat it was a clean-room test and to stay out, and the owner wrote "also clean room test라고 말하면 어떻게 ^^^ 그냥 "research some topic" 이런식으로 해야지". That run was void.

## Run one

1. Write the criteria first in `~/.prime/agent/clean-room/<change>/criteria.md`, before any run starts. Each line says what a person would see when the change works and can be checked from session files, the board, the duty runs or the Prompt view captures. Add a line that nobody stepped in.
2. Add a scenario file next to `checkin-real-task.ts` with the first message and an evaluator that reads each criterion, and register it in `SCENARIOS` in `clean-room.ts`.
3. From `components/user-history`, run `node --import tsx scripts/clean-room/clean-room.ts setup --scenario <name> --criteria <criteria.md> --cwd <repo the task belongs to> --name "<plain chat name>" --every-min <n> --run <run folder>`. If setup stops before it logs the check-in line, run the same command again with the same run folder. It finds what each create did, adopts or archives a chat a late create made, never builds the project twice, and never needs `--chat`. Never delete the run folder or the project to start over.
4. Start `clean-room.ts collect --run <run folder> --until <ISO time>` detached, the way the board skill's wait section says (`systemd-run --user` on a Linux box, `nohup` on the Mac), set `board.wake(at=...)` for the end of the window, and end your turn. When the window ends, collect runs evaluate itself.
5. Leave the chat, its jobs and its board alone until the window ends, and never trigger a run by hand.
6. Run `clean-room.ts evaluate --run <run folder>`, or read the verdict collect left, which is `<run>.pass.md`, `<run>.fail.md`, `<run>.void.md` or `<run>.open.md` next to the run folder. An open run has not reached a state a criterion needs: evaluated before the window ends it keeps running, and one still open at the end needs a new run with a longer window.
7. On a fail, send the failing criteria with their evidence quotes to the job that owns the change. After its next release, run setup again with a new run folder.
8. Run a void run again as it is, because someone stepped in and the system did not run alone.
9. Evaluate tears down every run with a pass, fail or void verdict and every run whose window ended, so nothing is left in the owner's chat list, For you, agents panel or boxes: it stops the run's processes, archives the chat and its jobs, ends the systemd user units the chat proved it made, marks each curated wiki page the chat made as test output with status archived (the wiki API has no delete), removes their todos and wakes, and deletes the run folder but keeps the verdict file (owner 10-18: "btw when blind test done always clean up").
10. A unit is the chat's only by a proof that collect records in the run's `units.json` while the run goes: the invocation ID systemd-run printed into a tool result of a session of the chat, or the sha256 of a unit file under `~/.config/systemd/user` whose last write fell inside a tool call of such a session that names the file. Teardown stops a transient unit only while that invocation runs and deletes a unit file only while it holds that content, so a unit of the same name that another job started or rewrote stays. A unit name or working directory never counts as proof, since another job can use the same name. On 10-19 readme-preview run4's server ran 7 h past teardown, which is why teardown ends proven units (trial-units.ts).

## Keep it real and safe

1. The task is small and real, with a number the chat can measure, so the check-in has a goal to push.
2. Pick a task that reads data and writes a page or a report, so its jobs need no push, deploy or prod write. The evaluator lists any such command it finds.
3. A short check-in interval on the new chat is fine, because c84 asks for the run, and no other chat's interval changes for it.
4. Never seed a copy of another chat's board: its todos land in the owner's For you, and its owners point at real jobs.
5. No correction or todo from the clean-room chat reaches the owner's correction ledger or his For you. The evaluator checks both, and teardown removes the chat's todos.
6. No global harness entry the trial writes reaches another session. Setup copies the published store `~/.prime/agent/harness/harness_state.json` into `<run>/harness` and files that folder in `clean-room-harness.json`, under each name before its create and under each session id after it, and the user-history extension points `RLM_GLOBAL_HARNESS_STATE_DIR` of each kernel of the chat, its jobs and their subagents at it. The trial starts from the published entries and its harness digest still reads the published store. A trial chat's first turn starts inside its create, so its first cells find the store by that name and a start time after the ask, and setup asks the server to name each fixture before its first message goes. Teardown keeps the trial's store as `<run>.harness_state.json` next to the verdict file. On 10-19 readme-preview run4's job saved a global memory about RefuseManualStop servers, and it loaded into every other live session (trial-harness.ts).
