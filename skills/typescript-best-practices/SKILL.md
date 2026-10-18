---
name: typescript-best-practices
description: "Use when reading or editing .ts or .tsx files. Type and boundary rules: discriminated unions, branded types, exhaustive switches, satisfies over as, boundary parsing."
---

# TypeScript best practices

This skill gives the TypeScript syntax for `principle-type-system-discipline` and `principle-boundary-discipline`. Examples are in `references/patterns.md`.

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
