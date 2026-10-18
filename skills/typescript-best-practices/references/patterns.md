# TypeScript patterns

Examples for the rules in `SKILL.md`.

## Branded types

```ts
type AgentId = string & { readonly __brand: "AgentId" };

function parseAgentId(input: string): AgentId {
  if (!isUUID(input)) throw new Error(`Invalid agent id: ${input}`);
  return input as AgentId;
}
```

## Discriminated unions

```ts
// Don't. Contradictory states compile.
type DiffState = { loading: boolean; diff?: GitDiff; error?: string };

// Do. Only valid states exist.
type DiffState =
  | { kind: "loading" }
  | { kind: "ready"; diff: GitDiff }
  | { kind: "error"; error: string };
```

Use one discriminant name across a codebase.

## Constructive modeling

```ts
type NonEmpty<T> = [T, ...T[]];
const isNonEmpty = <T>(arr: T[]): arr is NonEmpty<T> => arr.length > 0;

type Pairs<T> = [T, T][]; // even-length list; read it with pairs.flat()

// Don't. A comment holds the invariant.
type TimeRange = { start: Date; end: Date }; // start <= end

// Do. Derive the end with a rangeEnd() helper.
type TimeRange = { start: Date; durationMs: number };
```

Narrow a plain `T[]` once with `isNonEmpty`, then pass `NonEmpty<T>` along. Brand `durationMs` only if a raw number could reach it by mistake.

## Simplest total type

```ts
// Don't. The ! hides the empty case.
function newestSession(sessions: Session[]): Session {
  return sessions.at(0)!;
}

// Do. Strengthen the input and the assertion goes away.
function newestSession(sessions: NonEmpty<Session>): Session {
  return sessions[0];
}
```

Returning `Session | undefined` is the other total signature. Both move the empty case to the caller. A function such as `sum` that handles `[]` keeps `number[]`.

## Removing an `as`

Find why TypeScript cannot infer the type, then fix that cause:

- If a discriminant is missing, add one and switch to a discriminated union.
- If the source type is too wide, such as `Record<string, unknown>`, narrow it.
- If the data crosses an untyped boundary, add a parse function or a schema.
- If the type cannot be expressed, use a branded type or `satisfies`.

## Exhaustiveness

```ts
// Value-returning switch
default: {
  const _exhaustive: never = s;
  return _exhaustive;
}

// Statement switch
default: {
  const _exhaustive: never = s;
  void _exhaustive;
}
```

## Boundary validation

- Parse wire formats such as proto and JSON-RPC with `ignoreUnknownFields`, so old clients accept new fields.
- Store persisted JSON as a versioned blob and wrap its parse in try/catch.

## Schema-derived types

When a `.proto`, OpenAPI spec, GraphQL schema, or database migration defines a shape, derive from its generated type.

```ts
import type { ChecksMessage } from "<generated module>";

function renderChecks(s: Pick<ChecksMessage, "totalCount" | "checks">) {
  /* ... */
}
```
