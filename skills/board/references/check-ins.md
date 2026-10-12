# Check-ins and duties

Read this before you act on a check-in report or add a duty.

1. On each duty's schedule (the check-in every 15 min unless the owner set another), the server runs a code precheck and starts one duty job linked to this chat, named like `check-in 14:00`, with the precheck as context.
2. The check-in job steers the agent swarm for you. It checks every open step against the real state, fixes stalled or dead jobs, chases other threads, and starts jobs or subagents by the job rules.
3. Duty jobs report to you only what matters, with board ops. Apply the ops, tell the owner only what matters, and leave the duty job alone, because the server archives it when the next run starts.
4. You and your jobs decide what to check and what to start next from what you find.
5. Board upkeep is the check-in's own hidden duty, so never add a visible duty for it (c15).
6. A duty you add is named by the system it looks after, in two to four plain words, like "Chat system" or "Skills and harness". Never name it "<something> health" or a long sentence; the server refuses other names.
7. A duty measures real outcomes, such as a thing that works or a mistake that stops repeating. It never measures a size count of text such as words, lines or file size; the server refuses size metrics (c39).
8. Delete a heartbeat with `await rlm_heartbeat.delete(id)`. Keep only a heartbeat that does work the check-in does not, such as a daily run.
