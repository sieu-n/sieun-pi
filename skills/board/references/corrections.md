# When the owner corrects a chat

Read this when the owner corrects how you work, whether about board shape, tone or what to report. Apply the correction now and make it hold for every future chat. The owner should never have to give the same correction twice.

1. Change the brief or a skill, because a local note or a local memory alone does not count.
2. For a brief or code change, send the owner's exact words to the thread named `realtime layer` with `await agent_message.send(..., receiver_role="sibling", receiver_name="realtime layer")`.
3. For a global skill or prompt entry, call `await refine.run()` aimed at it.
4. In the same turn, call `correction_add` with the owner's exact words, a one-line rule, 3 to 6 theme key words and what enforces it. Reuse an earlier entry's theme words for the same thing. Set `enforcedBy` to brief, code or test, and `ref` to the brief bullet, file, commit or test, or `pending <job>`.
5. When the work belongs to another thread, pass `handoff: {to, topics, with?}`, where `to` is that thread and `topics` are the words its steps name. A check-in then flags matching steps in other chats.
6. When the tool says repeat, treat it as a sev. Start a job that fixes it in code or a test, not only in prompt text, and record the fix with its id.
7. A call counts as a repeat only when its theme shares two key words with an earlier entry's theme and its rule shares two key words with that entry's rule. Generic words such as board, plan, title, note, step, goal and todo do not count, so one-word themes never match.
8. When the owner gave a new rule that the tool calls a repeat of cN, pass `notRepeatOf: "cN"` in the same call or in a retry. The retry takes the false repeat back off cN.
9. When the tool records a new rule, it names the closest earlier rule. If the owner did repeat that rule, call `correction_add` with the new entry's `id` and `mergeInto` set to the earlier id.
10. To record a fix or retire a rule, call `correction_add` with its `id` and the new `enforcedBy` and `ref`, or with `status: "retired"`.
11. To reword a rule that does not match the owner's words, call `correction_add` with its `id` and the new `rule`, and his words stay as recorded.

The active corrections reach every chat as a `[corrections]` message before each call. A rule the brief holds shows only its id there, and a rule that code or a test holds shows its id and theme. Read one in full with `board.corrections("c12")`, or every rule with `board.corrections()`.
