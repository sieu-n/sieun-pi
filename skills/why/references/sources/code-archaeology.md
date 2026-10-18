# Source control notes

Git and `gh` hold commit messages, diffs, PR bodies, review threads, inline comments, tests, ADRs, and changelogs.
They are tied to the code that shipped, so they are the most trustworthy source.

## Commands

```bash
git log --follow --oneline -- <file>        # history through renames
git log -S '<exact string>' -- <file>       # commits that added or removed this text
git log -G '<regex>' -- <file>              # same, by pattern
git show <hash>                             # one commit's diff
git log <old>..<new> -p -- <file>           # changes between two points
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews,files
rg -l -i 'architecture.decision' --glob '*.md'        # ADRs
rg -n -C2 '(TODO|FIXME|HACK|XXX|NOTE)' <file>         # notes near the target
rg -l '<symbol>' --glob '*test*'                      # tests that name the edge case
```

The `reviews` and `comments` fields of `gh pr view` usually hold the debate about alternatives.

## Good evidence here

- A PR body that states the problem the change solves.
- A review thread that compares alternatives.
- An inline comment that explains a constraint next to the target line.
- A test name such as `test_handles_empty_page_when_cursor_expires` that names the edge case.
- A commit message that names a ticket, an incident, or a revert followed by a re-apply.

## Traps

- Squash merges drop the branch commits, so read the PR body and comments instead.
- A message like "small refactor" can hide a behavior change, so read the diff.
- A copied pattern carries its reason from where it started, so find the commit that first introduced it.
- Dependabot, Renovate, and automated backport commits carry no motivation, so skip them.
