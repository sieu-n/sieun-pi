# Git in a VP chat's work

Read this before a sieun-pi commit, a :5182 chat release, a merge, a push or a promote, and for the auto-sns-agent branch model.

## sieun-pi commits

1. sieun-pi has one contributor, the owner, so its local checkout is ground truth.
2. Rewriting unpushed local sieun-pi commits (rebase, amend) before a push needs no owner ask (c21).
3. Never force-push, and never rewrite pushed history.
4. Other jobs commit in the same sieun-pi checkout, so run `git add -- <new files>` first, then `git commit -m "..." -- <your files>`.
5. If you commit through a private index, run `git add -- <your files>` on the shared index afterwards so it does not go stale.
6. Never use --no-verify.
7. A skill or `config/AGENTS.md` edit reaches the other boxes only after it is pushed to GitHub `main`, because each box's prime-sync timer fast-forwards its checkout from there about once a minute.

## Releasing the :5182 chat

Ship a sieun-pi commit to the live chat with one command from the sieun-pi checkout:

```sh
node scripts/release-chat.mjs <sha> [--no-kickstart]
```

1. The command builds `~/.local/share/sieun-pi-chat/release-<sha7>` from `git archive`, links both node_modules folders to the checkout, and runs `npm run typecheck` (tsc and svelte-check) and `npm test` inside the release, then writes the packed client bundle. Those three steps get PATH and the locale from your shell and a fresh HOME, TMPDIR and XDG dirs under /tmp, and nothing else, so no agent socket, worker token, session dir or API key reaches a test.
2. `npm test` runs every file in `components/user-history/test`. Each one guards a real incident or an owner rule and names it on its first line. Add a test only for a failure that happened, with that line.
3. It points `current` at the release with one rename, restarts the chat and prints the release id on its last line. On a Linux box the restart is `systemctl --user restart sieun-pi-chat.service`, and only the Mac runs `launchctl kickstart -k gui/$UID/com.sieun.agent-chat`.
4. It takes `~/.local/share/sieun-pi-chat/release.lock` before the build and holds it to the restart, so a second release waits through the first one's whole build and tests. A release waits even when the running release's commit holds its own, because that build can still fail, and then the waiting release builds the commit itself.
5. It refuses, with exit 4, a commit that is not on origin's `main` as fetched at its start, so push the commit to `main` first. It never pushes anything itself. On 10-18 releases of unpushed commits went live, and release-322de20 had to be merged into `main` afterwards.
6. It refuses, with exit 3, a commit that does not descend from the live release's commit. On 10-15 at 18:32:56 KST one job flipped `current` back to release-81a0540 and another job flipped it to 476a86b 30 s later, because each ran the steps by hand.
7. To go back on purpose, run `node scripts/release-chat.mjs <sha or release id> --rollback`, which reuses a built release folder. Each release keeps only the folders of `current`, the release before it, the release the chat was last started on, a waiting release and any release a running process uses, so a rollback further back builds that commit again. A rollback onto a release folder already built skips the origin check and needs no network, so a known-good release works offline or after its commit was rebased off `main`. A rollback onto a commit with no folder yet needs the commit on origin's `main` like any release.
8. A release whose diff touches only scripts/duties or tests takes `--no-kickstart`, because duty prechecks read `current` at each run.
9. A commit that `current` already holds exits 0 with nothing built only when the chat was last restarted on `current` and, on Linux, the installed units match `current`'s. The release writes `started.json` at each restart, and the service must also be running by `systemctl --user is-active` or `launchctl print`, because the file alone only says what was started. Otherwise the same command restarts the chat and installs the units, so releasing a `--no-kickstart` commit again makes its restart.
10. Never run `ln -sfn` on `current` or kickstart the service by hand, because a hand step skips the lock and the newer-only check.
11. Releases that queue up fold into one build and one restart. The release that takes the lock reads the requests waiting for it, picks the queued commit on origin's `main` that holds its own commit, the live release and the most queued requests, builds it, flips `current`, restarts and logs `release-X covers the requests of ...`. Each covered caller then exits 0 with `already live in release-X`. A request that comes in during that build waits for the next batch, and the batch makes its own restart even then, because on 10-18 a queue that passed one restart on 12 times left the chat 51 min behind `current`. When the picked build fails, the release builds the next candidate down to its own commit, so a failing newer request fails only its own caller. A queued commit that neither holds nor is held by the picked one is left to its own release. The batch restarts unless every covered request passed `--no-kickstart`. A release that takes the lock with `restart.owed`, which helpers from before the fold leave for a waiting release, makes that restart before its build. On us-metal02 the journal shows 11 chat restarts from 16:04Z to 17:59Z on 10-18, one for each release that built.
12. After each restart the release checks that the chat answers `http://127.0.0.1:5182/` and is still the same process 8 s after its start, by `systemctl --user show` or `launchctl print`. It then waits until `http://127.0.0.1:5182/ready` answers 200, which the service sends once its first tick and the passes it queued ended, for up to 180 s, and a release from before `/ready` answers 404 there and stands on the 8 s. A start that exits or restarts in that time, or that gives no answer within 60 s, sends `current` back to the release the chat ran before, restarts that release and exits 5 with what failed. On 10-19 at 01:14Z release 9c2a7fd8 died 7 s after each start at listen on the systemd socket, and the chat crash-looped for 5 min until a job reverted it by hand. On 10-23 at 01:20Z release fbd5a0a0 passed the 8 s check, then its first job sweep threw 34 s after each start, and the chat crash-looped for 3.5 min until a job rolled it back.

## auto-sns-agent branches

1. Staging is the trunk, and only land.yml writes it, so nobody pushes staging by hand.
2. Each machine has one checkout and one dev branch (owner rule c119, 2026-10-27: "NO one machine should have one worktree. dev/sieun for metal-02, dev/sieun-mac for mac"). Every chat and job on us-metal02 commits on dev/sieun, and every chat and job on the Mac commits on dev/sieun-mac, with no per-job or per-session branch, clone or worktree. A dev branch takes commits on its own line, and it never rebases onto staging or takes staging back after a land.
3. Each green verify-dev push run on a dev branch makes land.yml squash that branch's newest green commit onto staging with a Land-From trailer and no owner ask, and that Land-From sha is the base of the branch's next land.
4. Only promote.yml moves main, by fast-forward to a checked staging sha, and only the release owner runs it.
5. A job's regular work ends at staging (c154, 2026-10-22). The release owner walks each prod promote with the owner, and a red `staging-check.yml` run, the full check of staging, holds only that walk and never a land.
6. The crawler, the observability dashboards and alert rules, and demo.virev.ai are the exceptions that jobs still ship to prod themselves, through `metal-deploy.yml`, `apps/infra/metal/deploy-obs.mjs` and the `deploy/virev-demo` ref that every dev push writes.
7. Demo work goes on the Mac's dev/sieun-mac, and `ci/*` branches and probe refs are throwaway refs that nobody commits on.
8. The full rules are in auto-sns-agent's `.agents/skills/repo/git-workflow/SKILL.md`, which you read with `node scripts/skills/read-skill.mjs repo/git-workflow` from that repo.

## Merges, pushes and promotes

The chat brief, the job reply guideline and the duty job brief all state the merge rule as `MERGE_RULE` in `components/user-history/src/shared/chat-board.ts`, and `test/merge-gate.test.ts` checks that this file holds it word for word:

> Never ask the owner to confirm a staging land, merge or deploy: do it on your own (owner 10-12). Owner rule c74 (2026-10-15): Until the proper launch, the owner pre-approves every prod promote, merge or push to main. Never put a promote, merge or push go on For you and never wait for one; the release owner promotes as soon as staging checks out. Owner rule c154 (2026-10-22) narrows it for prod deploys: a job's work ends at staging, the release owner walks each prod promote with the owner, and a step that waits on his answer to a prod deploy todo is waiting on him, so never close that todo or ship that deploy without his answer. Only crawler, observability dashboard and demo.virev.ai deploys still ship to prod without him. An outside send (an email, a ticket or support reply, a customer message, a post) still needs the owner's ok on a For you todo first (c37).

Do the merge or push yourself, and tell the owner what shipped in a chat message. An open todo that asks for a merge or push go can be checked off with a note that c74 covers it. In auto-sns-agent, c154 narrows this: a job lands to staging on its own, a prod promote is the release owner's walk with the owner outside the three exceptions above, and a prod deploy todo stays open until the owner answers it.

After launch, an owner rule that takes the standing go back sets `releaseGo.preapproval` in `components/user-history/src/shared/release-go.ts` to null, and the briefs then carry the rule from that code.
