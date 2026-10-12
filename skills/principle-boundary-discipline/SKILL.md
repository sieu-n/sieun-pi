---
name: principle-boundary-discipline
description: "Apply when wiring validation, error handling, or framework adapters. Put guards at system boundaries such as CLI args, config, network, and external APIs, trust internal types, and keep business logic in pure functions."
disable-model-invocation: true
---

# Boundary discipline

Validate, narrow types, and handle errors at system boundaries. Inside the system, trust the types and do not validate again.

## At a boundary

A boundary is CLI args, config files, external APIs, and network protocols.

- Validate input there and return errors.
- Parse raw data into domain types there.
- Validate config at parse time, not inside business logic.

## Inside the system

- Pass typed data and propagate errors.
- Skip nil checks deep in call chains when the boundary already validated the value.
- Keep business logic in pure functions with no framework dependencies, so the framework shell only calls them.
- Write parsers, prompt builders, and scorers as pure transforms from typed state to output.

## Across the boundary

- Expose domain concepts, and do not re-export transport, storage, framework, or wire types.
- Keep general mechanism inside and special-purpose policy at the edge.

## Tests

- If the data is not crossing a system boundary right now, remove the validation.
- If the logic can be a pure function that the shell calls, extract it.
