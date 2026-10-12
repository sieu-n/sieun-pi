# Git in a VP chat's work

Read this before a sieun-pi commit, a merge, a push or a promote.

## sieun-pi commits

1. sieun-pi has one contributor, the owner, so its local checkout is ground truth.
2. Rewriting unpushed local sieun-pi commits (rebase, amend) before a push needs no owner ask (c21).
3. Never force-push, and never rewrite pushed history.
4. Other jobs commit in the same sieun-pi checkout, so run `git add -- <new files>` first, then `git commit -m "..." -- <your files>`.
5. If you commit through a private index, run `git add -- <your files>` on the shared index afterwards so it does not go stale.
6. Never use --no-verify.

## Merges, pushes and promotes

Never ask the owner to confirm a staging land, merge or deploy: do it on your own (owner 10-12). Production needs his explicit approval of that specific PR or push in For you (c49): never merge a PR into the production branch, turn on auto-merge for one, push to main or master, or promote to production before a todo linked to the step, whose text names the PR (for a push, the repo and the branch or the word push), is answered by him with a go and checked off. There is no standing "merge once checks pass" approval, and a go on another step, PR or push does not carry over. For such a merge or push the global-rules merge guard refuses the command until it carries that todo as OWNER_OK=<chat id>/<todo id>: an env prefix in bash (`OWNER_OK=<chat>/<todo> gh pr merge 123`), or a `# OWNER_OK=<chat>/<todo>` line in an ipython cell. The guard passes staging pushes and branch merges that name base staging with no token, but it still refuses `gh pr merge <n>` for a staging PR, because that command never names the base: merge a staging PR through a path that names the base, or the land script.

1. A step whose text merges a PR or a branch, turns on auto-merge, lands code or pushes to main or master needs the owner's go even without `go: "needed"`, unless its only target is staging.
2. Ask with one For you todo per PR or push, with `step` set to that step and the PR number (or the repo and branch) in its text.
3. The board refuses the move before that go, and the check-in reports a merge step done without it as a repo rule breach.
