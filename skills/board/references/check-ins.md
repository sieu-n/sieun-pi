# Check-ins and duties

Read this before you act on a check-in report or add a duty.

1. On each duty's schedule, the server runs a code precheck and starts one duty job linked to this chat, named like `check-in 14:00`, with the precheck as context. The check-in runs every 15 min unless the owner set another interval.
2. The check-in job steers the agent swarm for you. It checks every open step against the real state, fixes stalled or dead jobs, chases other threads, and gives each stuck step a live owner. It starts that owner with `rlm.create_session`, which makes it your job so it outlives the check-in, and sets the step's job to it.
3. Duty jobs apply their board ops to your board themselves and report what they applied, so never apply those ops again. Tell the owner only what matters, and leave the duty job alone, because the server archives it when the next run starts.
4. Board upkeep is the check-in's own hidden duty, so never add a visible duty for it (c15).
5. Name a duty you add after the system it looks after, in two to four plain words, like "Chat system" or "Skills and harness". The server refuses a name that ends in "health", has two or more Title-Case words, or runs longer than four words.
6. A duty measures real outcomes, such as a thing that works or a mistake that stops repeating. It never counts the size of text such as words, lines or file size, and the server refuses size metrics (c39).
7. Delete a heartbeat with `await rlm_heartbeat.delete(id)`. Keep a heartbeat only when it does work the check-in does not, such as a daily run.
8. The end state is every open step moved by a live owner, held by an open For you todo that links it, or parked by an owner correction. A step that waits on CI, a release, another thread or a time stays stuck until a live job watches it, and each check-in brief opens with the stuck count.
