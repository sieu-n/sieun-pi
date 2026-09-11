# Evidence-driven spec review

Use the owner's approved reasoning method without relying on a private example repository.
A proposal is not proof of implemented behavior.

## Start with the whole task

An editor complaint can be about more than visual clutter.
Trace how a person creates content, edits it, previews it, publishes it and uses the result.
Inspect actual persistence and preview behavior before recommending a cosmetic change.

For example, a proposed editor design might need separate draft and published revisions.
That is a hypothesis to verify, not a rule for every editor.
If a preview uses a different revision from the saved draft, show that mismatch with observed evidence.
Preserve useful rendering and delivery code unless the evidence supports replacing it.

Explain what changed your recommendation. Separate source facts, owner requests, proposals and runtime checks.
A reviewer should understand why the rejected alternatives lose for this task.

## Shape to reuse

Principles → Today → Changes → Goals and status → Done when → Open questions.

Use short numbered statements, concrete before-and-after tables and wireframes with real copy.
Show relevant flow, data and state boundaries. Keep low-level source notes separate.
Each work unit ends with an observable check.

## Readiness questions

1. What is the user trying to complete?
2. Why does the current workflow fail?
3. Which observed facts changed the recommendation?
4. What is kept, moved, removed or added, and why?
5. Why do the concrete alternatives lose?
6. Are loading, error, recovery, stale-result and narrow-layout states specified where relevant?
7. Does each work unit have an observable acceptance check?
8. Are history, source risks, proposals and verified outcomes clearly separated?

Do not copy a fixed length, screen count or worker count. Matching headings with generic content is not enough.
