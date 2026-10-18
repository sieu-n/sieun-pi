---
name: principle-minimize-reader-load
description: "Use when reviewing or shaping code that is hard to trace. Count the layers between a question and its answer and the hidden state a reader must hold, then collapse one-caller wrappers and shrink mutable scope."
disable-model-invocation: true
---

# Minimize reader load

Reader load is the work a reader does to understand code. Measure it on two separate axes:

1. Layers to trace are the indirections between a question and its answer.
2. State to hold is the hidden or mutable context the reader keeps in their head.

A flat file with 50 globals can be as hard to read as a 6-layer adapter stack, so guard both axes.

## Pattern

- Inline wrappers with one caller, adapters with one implementation, and indirection built for a future that never came.
- Collapse a layer that repeats the methods and arguments of the layer next to it.
- Prefer a boundary that hides real decisions over a broad interface that hides little.
- Shrink state scope in this order: returns over mutations, locals over fields, fields over module state, and module state over globals.
- Derive a value instead of keeping two copies in sync.
- State an invariant once, at the boundary, so consumers do not repeat it.
- Add a layer or a piece of state only if it removes at least as much reader load somewhere else.

## Test

A new reader should answer "where does X come from?" and "what can change X?" in under 30 seconds. If not, cut layers or state.
