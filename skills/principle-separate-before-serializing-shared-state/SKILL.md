---
name: principle-separate-before-serializing-shared-state
description: "Apply when concurrent actors might write to the same file, branch, key, or state object. Remove the sharing first. Add a lock or other structural serialization only when one shared writer is a real requirement."
disable-model-invocation: true
---

# Separate before serializing shared state

If two actors write the same mutable state, first remove the sharing. Serialize only when one shared target is a real requirement, and then enforce it in structure. An instruction to "take turns" does not stop a race.

1. List the shared mutable state: files that several actors read and write, branches that several actors push to, and APIs that several actors define and consume.
2. Ask whether the actors need one canonical object or only publish independent facts.
3. If the facts are independent, give each actor its own file, key, branch, or state directory, and merge the results only where they are read.
4. Two workers that write their own `lastX` field into one `state.json` still share it, while `indexer-state.json` and `metrics-state.json` do not.
5. If one shared target is a real requirement, serialize access with a lockfile, sequential phases, a single-writer actor, or an atomic compare-and-swap.
6. Treat "we need a lock" as a sign to recheck the design before you add one.
