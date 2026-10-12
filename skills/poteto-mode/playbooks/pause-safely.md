### Pause safely

For "pause safely", "I need to go offline", "restart Prime Agent", and an imminent context compaction. "Keep going" and "going to bed, keep going" mean continue, not pause.

1. Stop at a safe boundary. Finish or back out of the current step, start nothing new, and cancel nested subagents.
2. Do not open a PR or push to pause unless one was already out.
3. Commit uncommitted edits as one `wip:` commit on the current branch, following the repo's commit rules. If the tree is broken, say so in the commit body.
4. Write a resume note to a file with the intent, progress, what is verified, the current state, next steps, key files, and gotchas. Put it in the project's artifact folder, not `/tmp`. If a show-me-your-work trail exists, point to it.

Reply with where you are, what is on disk and what is not, the commits you made, whether the tree is clean, and the first action on resume. Session pickup reads this note on resume.
