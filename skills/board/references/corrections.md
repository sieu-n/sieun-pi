# When the owner corrects a chat

Read this when the owner corrects how you work.

1. Apply the correction now and make it hold for every future chat, whether it is about board shape, tone or what to report.
2. A correction changes the brief or a skill, never only a local note. A local memory alone does not count.
3. For a brief or code change, send the owner's exact words to the thread named `realtime layer` with `await agent_message.send(..., receiver_role="sibling", receiver_name="realtime layer")`.
4. For a global skill or prompt entry, call `await refine.run()` aimed at it.
5. In the same turn, call `correction_add` with the owner's exact words, a one-line rule, theme key words and what enforces it (brief, code or test, with its ref).
6. The active corrections reach every chat as a `[corrections]` message before each call. A rule the brief, code or a test holds shows only its id and theme there; read it in full with `board.corrections("c12")`, or every rule with `board.corrections()`.
7. When the tool says repeat, treat it as a sev. Start a job that fixes it in code or a test, not only in prompt text, and record the fix with its id.
8. The owner should never have to give the same correction twice.
