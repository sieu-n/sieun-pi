# When the owner corrects a chat

Read this when the owner corrects how you work.

1. Apply the correction now and make it hold for every future chat, whether it is about board shape, tone or what to report.
2. A correction changes the brief or a skill, never only a local note. A local memory alone does not count.
3. For a brief or code change, send the owner's exact words to the thread named `realtime layer` with `await agent_message.send(..., receiver_role="sibling", receiver_name="realtime layer")`.
4. For a global skill or prompt entry, call `await refine.run()` aimed at it.
5. In the same turn, call `correction_add` with the owner's exact words, a one-line rule, 3 to 6 theme key words (reuse an earlier entry's words for the same thing) and what enforces it: `enforcedBy` brief, code or test, and `ref`, the brief bullet, file, commit or test, or `pending <job>`.
6. The active corrections reach every chat as a `[corrections]` message before each call. A rule the brief holds shows only its id there, and a rule code or a test holds shows its id and theme; read it in full with `board.corrections("c12")`, or every rule with `board.corrections()`.
7. To record a fix or retire a rule, call `correction_add` with its `id` and the new `enforcedBy` and `ref`, or `status: "retired"`. To reword a rule that does not match the owner's words, call it with its `id` and the new `rule`; his words stay as recorded.
8. When the work belongs to another thread, pass `handoff: {to, topics, with?}`: `to` is that thread, `topics` the words its steps name. A check-in then flags matching steps in other chats.
9. When the tool says repeat, treat it as a sev. Start a job that fixes it in code or a test, not only in prompt text, and record the fix with its id.
10. The owner should never have to give the same correction twice.
