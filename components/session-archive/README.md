# session-archive

A daily sweep that archives job sessions on this box once they finished and stayed idle for over 24 h. On 11-08, 2,285 of the 2,682 live sessions on us-metal02 were such jobs, and every wake of a tree reads its sessions again.

`sweep.py` reads the daemon's rows with `prime-agent sessions --all --json`. It picks each live subagent, and each root that a chat started with `rlm.create_session` (`chat-jobs.json`, or a `root` row in the chat's agents route). It keeps a session that is a chat thread or another top-level session, that works, queues, asks or failed, that waits on a `board.wake`, that the chat's agents route shows as working or waiting, that an open board step names, or that saw activity in the last 24 h. A session above any kept one stays too, because Prime's archive of a session cancels the scheduled jobs of its whole tree.

Each pick goes through the chat service's `POST api/threads/<id>/archive` with `{"by": "idle_job_end"}`, deepest first. The route archives it with Prime's `archive_saved_session` and records the archive in `service-archives.json` as the service's, so no reader takes it for the owner's. Nothing here deletes or moves a session file.

Each run appends its counts to `~/.prime/agent/session-archive/runs.jsonl` and one line per archive to `archived.jsonl`. An archived session is no longer live, so a second run picks nothing new.

1. To see what a run would archive, run `python3 -B components/session-archive/sweep.py --dry-run`.
2. To install a commit, run `python3 -B components/session-archive/install.py --ref <sha>`, which enables `session-archive.timer` (19:30 UTC daily).
3. To test, run `python3 -B -m unittest discover -s components/session-archive/tests`.
