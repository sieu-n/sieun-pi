---
name: principle-laziness-protocol
description: "Apply when refactoring, judging diff size, or about to add an abstraction, a layer, or a new signal threaded through several layers. Prefer deletion and the smallest change that solves the problem."
disable-model-invocation: true
---

# Laziness protocol

Writing code costs you little, so you over-build. Write code as if you had to maintain it by hand.

- When asked to refactor or improve code, look for things to delete before adding anything.
- If answering a question needs tracing through more than 3 files or layers, flatten the calls.
- A rich interface that hides real work is fine and does not count as a deep call chain.
- Make each choice in one place and pass the result on as a plain flag.
- Make the smallest change that solves the problem, even if a longer version looks cleaner.
- If a task asks you to thread a new signal through types, schemas, or pipelines, stop and look for a direct path.
- Remove small pass-throughs, representation leaks, and duplicated choices when you see them.

If a human developer would find the code tiring to maintain, pick a smaller solution.
