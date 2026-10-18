# Clean-room runs

Read this before you call a harness, skill or tool change done. The owner's rule c84 says a change is done only when a clean session, run by the system with nobody stepping in, shows the intended behavior and a file records the pass.

The lever is `components/user-history/scripts/clean-room/clean-room.ts` in sieun-pi. It opens a chat through the chat server's own routes, lets the server run it, saves the evidence and judges it. `checkin-real-task.ts` next to it is the model scenario: a fresh chat with one ordinary owner-style message and nothing seeded.

## Never tell it

A clean-room chat gets a real, ordinary task and never learns it is a test. Its first message reads like the owner's ("research which of our instagram index gaps matter most and keep a page with the top 10 updated"), its name is a plain one he would pick, and no board item, todo, job name, note or AGENTS.md says test, twin, fixture or clean room. On 10-15 the first run told its chat it was a clean-room test and to stay out, and the owner wrote "also clean room test라고 말하면 어떻게 ^^^ 그냥 "research some topic" 이런식으로 해야지". That run was void.

## Run one

1. Write the criteria first in `~/.prime/agent/clean-room/<change>/criteria.md`, before any run starts. Each line says what a person would see when the change works and can be checked from session files, the board, the duty runs or the Prompt view captures. Add a line that nobody stepped in.
2. Add a scenario file next to `checkin-real-task.ts` with the first message and an evaluator that reads each criterion, and register it in `SCENARIOS` in `clean-room.ts`.
3. From `components/user-history`, run `node --import tsx scripts/clean-room/clean-room.ts setup --scenario <name> --criteria <criteria.md> --cwd <repo the task belongs to> --name "<plain chat name>" --every-min <n> --run <run folder>`.
4. Start `clean-room.ts collect --run <run folder> --until <ISO time>` detached with `nohup`, set `board.wake(at=...)` for the end of the window, and end your turn.
5. Leave the chat, its jobs and its board alone until the window ends, and never trigger a run by hand.
6. Run `clean-room.ts evaluate --run <run folder>`, which writes `<run>.pass.md`, `<run>.fail.md`, `<run>.void.md` or `<run>.open.md` next to the run folder. An open run has not reached a state a criterion needs, so it gets more check-ins.
7. On a fail, send the failing criteria with their evidence quotes to the job that owns the change. After its next release, run setup again with a new run folder.
8. Run a void run again as it is, because someone stepped in and the system did not run alone.
9. After the pass, run `clean-room.ts teardown --run <run folder>`, which removes the chat's todos so the owner's For you does not count them, archives the chat and every job it had through the chat server's archive route, and drops their wakes.

## Keep it real and safe

1. The task is small and real, with a number the chat can measure, so the check-in has a goal to push.
2. Pick a task that reads data and writes a page or a report, so its jobs need no push, deploy or prod write. The evaluator lists any such command it finds.
3. A short check-in interval on the new chat is fine, because c84 asks for the run, and no other chat's interval changes for it.
4. Never seed a copy of another chat's board: its todos land in the owner's For you, and its owners point at real jobs.
5. No correction or todo from the clean-room chat reaches the owner's correction ledger or his For you. The evaluator checks both, and teardown removes the chat's todos.
