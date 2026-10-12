### Worktree and simulator cleanup

For "clean up worktrees", "free up space", and "delete old simulators". Deletion cannot be undone, so every step checks that nothing in use or uncommitted is lost.

1. Record `df -h /`. Run `bash "$POTETO_MODE_DIR/scripts/worktree-audit.sh"` through Prime's `bash(...)` from the target project. It reads paths from `git worktree list` and suggests a bucket for each worktree from its size, age, merge state, uncommitted work, PR state, and the newest chat that touched it. The transcript scan is slow, so run it in the background.
2. Treat the bucket as advice. Get the pinned and active chats from the user and check every candidate against them. The pinned set wins over a `safe` bucket.
3. For each `verify-recent-chat` row, or any row you doubt, have subagents read the transcripts and report which worktrees the chat touches. A pinned chat's subagents may use sibling worktrees whose names never appear in the sidebar.
4. Pause on `wip:N`, which means N tracked uncommitted edits. Show the diff and get a decision. `scratch:N` means untracked files that are safe to drop, but name them. Clean, merged worktrees that no chat uses can go without asking.
5. For each confirmed path, run `git worktree remove --force <path>`. If the directory survives on ignored build output, `rm -rf` it. Then run `git worktree prune`. Branch refs stay, so no commits are lost. Re-run `df -h /` and list the worktrees again.
6. For simulators, run `xcrun simctl --set testing delete all`, `xcrun simctl delete unavailable`, and `xcrun simctl runtime list` followed by `runtime delete <id>` for old runtimes. Xcode `DerivedData`, `iOS DeviceSupport`, and package caches are the next places to look. Keep any cache the user asked to keep.

Reply with `df -h /` before and after, the worktrees pruned, and one line for each worktree held back with the chat that uses it or its uncommitted work.
