### Feature

Delegate the implementation and stay in the lead.

1. Run the how skill over the affected subsystem.
2. Run the architect skill. If you skip it, write `architect skipped: <reason>`.
3. Write the throughput checkpoint as four checklist items. Mark an item that does not apply as `n/a: <reason>`.
   - Name the blocking first steps that run before any fan-out.
   - Name the independent workstreams, meaning disjoint files, services, or layers.
   - Name the shared mutable state, and split it per principle-separate-before-serializing-shared-state unless a real invariant needs one writer.
   - Name the smallest safe decomposition, and say why if one worker is best.
4. Delegate the code to a subagent, using the feature role from the model policy in Subagents. Give it file paths, success criteria, and the data shape with its structure from principle-model-the-domain. When the change has several valid shapes, delegate through the arena skill instead. Do this even for a small app. A subagent that cannot spawn writes the diff itself and keeps the review separate. Review the diff yourself. Update every consumer of a shared primitive you change, and verify each one.
5. Verify on the real surface. An inconclusive result or a different surface is not a pass.
6. Order the work as small commits, each built and verified before the next.
7. Run the interrogate skill if the design is contested.
8. Run `playbooks/opening-a-pr.md`.

Give code-coupled work to one owner, who fans out after the blocking phase. Fan out from the parent only for slices with independent outputs, such as audits or competing experiments. Rewrite the checkpoint at each phase boundary.

Reply with what you built, what you chose and why, and open decisions. Use a table for design alternatives.
