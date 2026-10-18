# Architectural critique rubric

Apply the lenses that fit the subsystem. Not every lens applies.

## Abstraction fit

- Does each abstraction stand for a real concept, or is it a layer added "in case we need it"?
- Do the boundaries separate things that change independently?
- Do components share implementation details they should not need to know?
- Is business logic mixed into framework wiring?

Too much abstraction is as bad as too little. A flat design is fine when the domain is small.

## Data model

- Do the data structures match how the data is accessed, or only how someone first modeled it?
- Does code keep reshaping data because the model does not fit the access pattern?
- Do the types match what the data looks like at runtime, or do they claim more structure than exists?

## Boundary discipline

- Is validation at entry points, or scattered through internal code?
- Are errors handled at boundaries and passed on cleanly, or caught and re-thrown at every layer?
- Does data cross boundaries in well-typed shapes, or as bags of optional fields?
- Can this subsystem be tested alone, or does it need the whole system running?

## Evolution readiness

- If the most likely next requirement landed tomorrow, would one file change or everything?
- Which hardcoded assumptions would need to loosen?
- Does the design look bolted on, or as if it was always part of the plan?
- Do legacy paths survive for a compatibility need that nothing has?

Judge only changes that the codebase's direction makes likely.

## Complexity against value

- Does complexity sit where it is needed, such as core logic and tricky invariants, or in boilerplate, extra indirection, and configuration?
- Is there a simpler way to get the same behavior?
- Does every component still have a job, or are some left over from an earlier design?

## Consistency

- Does this area solve problems the same way the rest of the codebase does, or does it invent its own patterns?
- If the patterns differ, is there a reason?

Inconsistency nobody can explain costs maintenance time.
