---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Spawns one reviewer per configured model on the same prompt, then the lead filters their findings into a verdict."
disable-model-invocation: true
---

# Interrogate

Spawn one reviewer per configured model. Every reviewer gets the same prompt and rubric; the different blind spots of different models produce the adversarial signal. A finding that two or more models raise on their own is strong. A finding from one model is weaker but still worth reading.

The deliverable is a verdict. Do not apply any change yourself.

Spawning, briefs, and draining follow [`../setup-pstack/references/prime-agent-runtime.md`](../setup-pstack/references/prime-agent-runtime.md). At the `RLM_MAX_DEPTH` ceiling, run the review prompt yourself and say in the verdict that one model reviewed.

## Step 1: Pick the scope

- If the user names files or a diff, review those.
- On a feature branch, review `git diff main...HEAD`, or the diff against the right base branch.
- If the user points at recent work, gather the files it touched.

Package the diff or files with the context files a reviewer needs to read the code.

## Step 2: State the intent

Write one paragraph that says what the change is trying to do. Take it from the user's message, the commit messages, the PR description, and the code. Reviewers challenge how well the code meets the intent, not the intent itself. If you cannot tell the intent, ask the user before you spawn.

## Step 3: Spawn reviewers

Read the reviewer list from the `interrogate reviewers` role in `~/.prime/agent/pstack-models.json` (repo default `config/pstack-models.json`). Spawn one reviewer per entry, labelled Reviewer A, B, C, and so on. Without that role, spawn two reviewers on `inherit-parent`.

```python
import json, pathlib
CFG = pathlib.Path.home() / ".prime/agent/pstack-models.json"
roles = json.loads(CFG.read_text())["roles"] if CFG.exists() else {}
reviewers = roles.get("interrogate reviewers") or [{"model": "inherit-parent"}] * 2
```

- Spawn every reviewer from one cell with `await rlm.spawn(brief, name=..., model=..., thinking=...)`.
- For `inherit-parent` or `auto`, omit `model=`, and omit `thinking=` unless the entry sets it.

If `rlm.spawn` rejects a model selector, run `await rlm.find_models('<family>')` and spawn on the closest live selector that the `policy` block in `pstack-models.json` allows. Finish the review, then tell the user to fix the role with the `setup-pstack` skill.

Fill [`references/reviewer-prompt.md`](references/reviewer-prompt.md) with the intent, the diff or files, [`references/rubric.md`](references/rubric.md), and [`references/code-quality-review.md`](references/code-quality-review.md). Send the same filled prompt to every reviewer.

## Step 4: Merge the findings

1. Merge findings that describe the same issue in different words, and record which models raised each one.
2. Mark findings that two or more models raised on their own as consensus.
3. Record where one model flags something and another says the opposite.

## Step 5: Judge

You are the lead reviewer. Reviewers saw a slice of the code and one paragraph of intent; you know the goal, the constraints, and the tradeoffs already made. Filter with [`references/lead-judgment.md`](references/lead-judgment.md).

Put every finding in one bucket:

- Act on holds real correctness, security, or maintainability issues that would block a real PR.
- Consider holds valid points where you cannot tell if the fix is worth its cost now.
- Noted holds points that are right but not worth acting on at this stage.
- Dismissed holds findings that are wrong, nitpicks, or missing context.

Each finding names the models that raised it and gives a one-line reason for its bucket.

## Output format

### Intent
> [The paragraph from Step 2]

### Reviewers
- Reviewer [label] ran on [model] and filed [N] findings.

### Act on
[For each finding, give the issue, the models that raised it, and why it matters.]

### Consider
[For each finding, give the issue, the models that raised it, and the tradeoff.]

### Noted
[A short list.]

### Dismissed
[Each rejected finding with its reason, so the user can override you.]

### Agreement map
[Where the models agreed, where they split, and what that pattern says.]
