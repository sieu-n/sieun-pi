---
name: principle-migrate-callers-then-delete-legacy-apis
description: "Use when you add a new internal API and old callers still use the old one. Move every caller to the new API and delete the old API in the same change; do not keep a compatibility layer."
disable-model-invocation: true
---

# Migrate callers, then delete the legacy API

Use this rule when no external user depends on the old API and the project can take a coordinated breaking change.

1. List every caller of the old API.
2. Move each caller to the new API.
3. Delete the old API in the same change.
4. Rewrite tests to check the new contract, and delete tests that only pin the old implementation.

Do not keep the old API alive because internal callers still use it.
Add a temporary adapter only when the change cannot land in one step, and give it a removal date.
