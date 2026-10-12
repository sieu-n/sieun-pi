### Refactoring

For renames, extracts, inlines, dedupes, and moves that keep behavior. If the cleanup reveals a missing feature or a bug, split it out and ship the structural change first. A named redesign goes to Feature. A migration across many call sites goes to the figure-it-out skill.

1. Pin the behavior first. Run the how skill to learn the contract, then write a characterization test, snapshot, or equivalence harness. Type checks and lint are not a pin.
2. Name the structure the code is missing per principle-model-the-domain. Leave plain code alone when its shape is already clear. The new shape must delete branches or invalid states, not add indirection.
3. Name the target layout, types, and call graph as you would build them today. Run the architect skill if the target crosses a function boundary.
4. Delete dead code, one-caller wrappers, and orphan references before you add the new shape.
5. Move in small steps that keep the pin green. Migrate every caller and delete the old API in the same wave, with no shims. Check every rename against the files, including strings and docs. Delegate mechanical edits to a subagent, using the refactoring role from the model policy in Subagents, with the paths, names, and behavior to hold. Review the diff.
6. Prove behavior did not change on the real artifact. For larger changes, diff old and new outputs or replay a recorded baseline. Do not trust a delegate's summary.
7. Revert the change if it does not lower reader load somewhere, per principle-minimize-reader-load.
8. Order the commits as subtraction, then reshape, then cleanup, each green. Run `playbooks/opening-a-pr.md`.

Reply with what structure changed, the pin, the equivalence proof, the reader-load change, and what you reverted.
