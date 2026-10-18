### Visual parity

For "make X match Y exactly", styling-system migrations, and UI ports across frameworks. The baseline is the spec, and an image diff decides.

1. Build the baseline before any migration. Use a harness that screenshots the current component in each state, plus the target when you match two implementations.
2. Never edit the harness or the baseline, and never restructure a component to pass a diff. If the baseline looks wrong, stop and ask.
3. Migrate shared primitives first. Then migrate one component at a time, one owner per component in its own worktree.
4. Diff each component against its baseline on the real surface. Any nonzero diff fails. Repeat until it is zero.
5. Run `playbooks/opening-a-pr.md` per component or per safe batch.

Reply with each component migrated with its diff result, the harness location, and what is left.
