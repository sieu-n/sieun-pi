---
name: principle-redesign-from-first-principles
description: "Apply when a new requirement lands on an existing design. Redesign as if the requirement had been there from day one instead of bolting it on."
disable-model-invocation: true
---

# Redesign from first principles

Do not bolt a new requirement onto the current design. Build what you would have built if you had known about it on day one.

1. Read every affected file and learn how the current design fits together.
2. Ask what you would build from scratch with the new requirement in place.
3. Carry the change through every reference, including types, docs, and examples.
4. Plan the whole redesign first, then ship it in small checked steps with principle-sequence-verifiable-units.
