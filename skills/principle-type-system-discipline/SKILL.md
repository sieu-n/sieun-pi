---
name: principle-type-system-discipline
description: "Apply when designing types, reviewing a function signature, or writing code in any statically typed language. Make illegal states unrepresentable, brand semantic primitives, parse external data at boundaries, avoid casts, match variants exhaustively, and derive types from authoritative schemas."
disable-model-invocation: true
---

# Type system discipline

Use the type checker to rule out impossible states, mixed-up primitives, and unhandled variants at compile time. Remove a special case from the types before you add a handler for it.

This applies to any typed language. `typescript-best-practices` gives the TypeScript syntax.

## Make illegal states unrepresentable

- Model variants as a sum type, such as a discriminated union, a Rust enum with payloads, or a sealed class.
- Do not model state as optional fields whose contradictory combinations compile.
- `{ completed: boolean; completedAt?: Date }` admits `completed: true` with no date, so derive `completed` from `completedAt` or write `{ kind: 'open' } | { kind: 'done'; at: Date }`.

## Build the type from the values you want

- Construct the shape that cannot hold the illegal value, then expose the interface callers need on top of it.
- Build a non-empty list as a head plus a rest, and a valid time range as a start plus a duration.

## Brand semantic primitives

- Give `UserId` and `OrderId` distinct types even when both are strings, using a newtype, opaque type, or branded type.
- Validate once when you create the value, and trust the type downstream.

## Parse external data at the boundary

- Treat RPC payloads, JSON, IPC messages, CLI args, config files, environment variables, and database rows as untyped until a parse function turns them into the typed model.
- Follow `principle-boundary-discipline` for where the parse goes.

## Do not lie to the compiler

- Avoid casts, unsafe coercions, and assertion functions that bypass the checker.
- If the compiler cannot prove a fact, validate, narrow, or change the model so it can.

## Match variants exhaustively

- Make the compiler fail when someone adds a variant and a match does not handle it.
- Use the language idiom, such as a `never` binding in TypeScript, `match` in Rust, or `-Wincomplete-patterns` in Haskell.

## Derive types from authoritative schemas

- Derive types from the protobuf, OpenAPI spec, GraphQL schema, migration, or token file that owns the shape, and do not hand-write a parallel type.
- Follow `principle-encode-lessons-in-structure` for turning that rule into a check.

## Strengthen a type only where partiality appears

- Treat a runtime assertion, null check, or "should never happen" throw as the sign that a type is too weak, and move that check into the type.
- Stop once each use site handles only the cases it must, because more precision costs reuse and buys no safety.
- Keep functions total: `sum` takes a plain list because an empty list sums to 0, and `head` takes a non-empty list because an empty one has no answer.

## Tests

- If you could write a comment saying when a field combination is valid, split the type into a sum type.
- If two arguments share a primitive type but mean different things, brand them.
- If you find an `any`, `as`, or `assertNotNull`, trace it to the boundary and validate there.
- If the compiler would not flag a new variant next month, make the match exhaustive.
- If a type duplicates a shape another file owns, derive it.
- If nothing would panic without the stronger type, keep the plain type.
