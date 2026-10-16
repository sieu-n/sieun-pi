# Git in a VP chat's work

Read this before a sieun-pi commit, a :5182 chat release, a merge, a push or a promote.

## sieun-pi commits

1. sieun-pi has one contributor, the owner, so its local checkout is ground truth.
2. Rewriting unpushed local sieun-pi commits (rebase, amend) before a push needs no owner ask (c21).
3. Never force-push, and never rewrite pushed history.
4. Other jobs commit in the same sieun-pi checkout, so run `git add -- <new files>` first, then `git commit -m "..." -- <your files>`.
5. If you commit through a private index, run `git add -- <your files>` on the shared index afterwards so it does not go stale.
6. Never use --no-verify.

## Releasing the :5182 chat

Ship a sieun-pi commit to the live chat with one command from the sieun-pi checkout:

```sh
node scripts/release-chat.mjs <sha> [--test test/<file>.test.ts]... [--no-kickstart]
```

1. The command builds `~/.local/share/sieun-pi-chat/release-<sha7>` from `git archive`, links both node_modules folders to the checkout, and runs `npm run typecheck` and each `--test` file inside the release, niced.
2. It points `current` at the release with one rename, runs `launchctl kickstart -k gui/$UID/com.sieun.agent-chat`, and prints the release id on its last line.
3. It holds `~/.local/share/sieun-pi-chat/release.lock` from start to kickstart, so a second release waits for the first one.
4. It refuses, with exit 3, a commit that does not descend from the live release's commit. On 10-15 at 18:32:56 KST one job flipped `current` back to release-81a0540 and another job flipped it to 476a86b 30 s later, because each ran the steps by hand.
5. To go back on purpose, run `node scripts/release-chat.mjs <sha or release id> --rollback`, which reuses a built release folder.
6. A release whose diff touches only scripts/duties or tests takes `--no-kickstart`, because duty prechecks read `current` at each run.
7. Never run `ln -sfn` on `current` or kickstart the service by hand, because a hand step skips the lock and the newer-only check.

## Merges, pushes and promotes

The chat brief, the job reply guideline and the duty job brief all state the merge rule as `MERGE_RULE` in `components/user-history/src/shared/chat-board.ts`, and `test/merge-gate.test.ts` checks that this file holds it word for word:

> Never ask the owner to confirm a staging land, merge or deploy: do it on your own (owner 10-12). Owner rule c74 (2026-10-15): Until the proper launch, the owner pre-approves every prod promote, merge or push to main. Never put a promote, merge or push go on For you and never wait for one; the release owner promotes as soon as staging checks out. An outside send (an email, a ticket or support reply, a customer message, a post) still needs the owner's ok on a For you todo first (c37).

Do the merge, push or promote yourself, and tell the owner what shipped in a chat message. An open todo that asks for a merge, push or promote go can be checked off with a note that c74 covers it.

The switch is `releaseGo.preapproval` in `components/user-history/src/shared/release-go.ts`, which holds the c74 words and date. The briefs read it. When an owner rule after launch takes the standing go back, that one field becomes null and the briefs carry the old rule (c49):

> Never ask the owner to confirm a staging land, merge or deploy: do it on your own (owner 10-12). Production needs his explicit approval of that specific PR or push in For you (c49): never merge a PR into the production branch, turn on auto-merge for one, push to main or master, or promote to production before a todo linked to the step, whose text names the PR (for a push, the repo and the branch or the word push), is answered by him with a go and checked off. There is no standing "merge once checks pass" approval, and a go on another step, PR or push does not carry over.

Under that rule you ask with one For you todo per PR or push, with `step` set to that step and the PR number, or the repo and branch, in its text. `SKILL.md` under "The owner's go" lists which step texts count as a merge and which count as staging only.
