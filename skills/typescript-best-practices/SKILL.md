---
name: typescript-best-practices
description: "Use when reading or editing .ts or .tsx files, or when you design types or a signature in any typed language. Type and boundary rules: discriminated unions, branded types, exhaustive switches, satisfies over as, boundary parsing."
---

# TypeScript best practices

Use the type checker to rule out impossible states, mixed-up primitives and unhandled variants at compile time. This skill gives the TypeScript syntax, and `principle-boundary-discipline` says where the parse goes. Examples are in `references/patterns.md`.

| Rule | What to do |
|------|------------|
| Discriminated unions | Model variants with a `kind` literal field. Do not use a bag of optional fields. |
| Branded types | Brand primitives as `string & { readonly __brand: "X" }`. Validate once in the parse function that creates them. |
| Constructive modeling | Pick a shape that cannot hold the illegal value: `[T, ...T[]]` for non-empty, `[T, T][]` for even length, `start` plus `durationMs` for a range. |
| Simplest total type | Keep `T[]` while every operation on it is total. Use `NonEmpty<T>` only where `T[]` forces a `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | Type external data as `unknown` and narrow it before use. |
| No `as` casts | Use `as` only after validation proves the claim. |
| Narrowing order | Prefer a discriminant switch, then `in`, then `typeof` or `instanceof`, then a type guard, then `as`. |
| Type guards | A guard must check the whole claim its return type makes. Name it `isX` or `hasX`. |
| Exhaustiveness | Put `const _exhaustive: never = x;` in the `default` arm of every switch on a union. |
| `satisfies` over `as` | Use `satisfies` to check a literal against a type and keep its literal types. |
| Boundary validation | Parse data into a named domain type where it enters. No loose map type such as `Record<string, unknown>` gets past that parse. Do not validate again inside. |
| Schema-derived types | Derive with `Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, or `typeof` before you write a new interface. |
| Object args | Pass one object instead of positional args. Keep positional args on hot paths such as per-frame render, tokenizers, and parsers. |
| Real tests | Run the real code in tests and mock only what cannot run locally. Use the framework's test primitives with leak and disposable checks, and check UI in a running build. |
| Logging | Log through the project's structured logger with an id that leads to the context. Ship no `console.log`. |

## Other typed languages

The same rules hold in any typed language, with that language's idiom.

- In Python, model variants as frozen dataclasses joined in a union with a `Literal` tag, brand with `NewType`, end a `match` with `assert_never`, and parse input with a dataclass or pydantic model at the edge.
- In Rust, use an enum with payloads, a newtype, an exhaustive `match`, and `serde` at the edge.
- Derive types from the protobuf, OpenAPI spec, GraphQL schema, migration or token file that owns the shape, and never hand-write a parallel type.

## Tests

- If you could write a comment saying when a field combination is valid, split the type into a sum type.
- If two arguments share a primitive type but mean different things, brand them.
- If you find an `any`, an `as` or a non-null assertion, trace it to the boundary and validate there.
- If the compiler would not flag a new variant next month, make the match exhaustive.
- If a type duplicates a shape another file owns, derive it.
- If nothing would break without the stronger type, keep the plain type.
