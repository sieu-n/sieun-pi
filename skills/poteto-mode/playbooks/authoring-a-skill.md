### Authoring or modifying a skill

1. Follow Prime's skill-creator skill.
2. Check that the frontmatter has `name` and `description`, that referenced files exist, and that links to other skills resolve.
3. Write test cases if the change is structural. Skip them if it is a matter of taste.
4. Run `playbooks/opening-a-pr.md`.

When in doubt, delete. Keep a sentence only if it changes what the agent does. Tell the agent what to do and skip the reason unless the rule is confusing without one. Point at types, READMEs, and config instead of copying details that go stale. Point at other skills by path instead of restating them. Propose a new skill for a workflow you keep repeating.

Reply with the skill's purpose, the main design choices, and how you validated it.
