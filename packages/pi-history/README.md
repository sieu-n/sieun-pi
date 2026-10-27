# pi-history

pi-history keeps a full-text index of every Prime and Pi session transcript on one box and answers searches on a unix socket.
The contract between its parts is `~/work/chat-history-search/API.md` on us-metal02.
Each box runs its own copy over its own files, and a search on one box asks the other box's copy through prime-relay.

## What it indexes

The indexer reads every file named `<uuid>.jsonl` or `<prefix>_<uuid>.jsonl` under `~/.prime/agent/sessions`, `~/.prime/agent/session-artifacts` and `~/.prime/agent/pi-sessions`.
`src/core/extract.ts` turns each line into docs of eight kinds: user, assistant, thinking, tool_call, tool_result, agent_message, notice and summary.
It skips base64 images, thinking signatures, the `details` copy of tool output, bookkeeping entries and the custom messages in its `BOILERPLATE` list.
Tool results stay whole.

## How it follows the files

1. On start the indexer walks the three folders and indexes the newest files first.
2. Each file keeps `indexed_to`, the byte after its last indexed newline, so a half-written line waits for the next pass.
3. A file that shrinks below `indexed_to`, or whose byte before `indexed_to` is no longer a newline, was rewritten, so the indexer drops its docs and reads it again.
4. One step reads up to 1 MB of one file and writes its docs and the new `indexed_to` in one transaction, so a crash resumes where the last commit ended.
5. On Linux it watches each folder that changed in the last two days with `fs.watch`, and on macOS it watches each tree with one FSEvents stream.
6. A stat sweep every 30 s catches whatever the watchers miss.

## Run it

```sh
node src/main.ts [--db <path>] [--socket <path>] [--dir <folder> ...]
```

The database defaults to `~/.local/state/pi-history/history.db` on Linux and `~/Library/Application Support/pi-history/history.db` on macOS.
The socket defaults to `$XDG_RUNTIME_DIR/pi-history/history.sock` on Linux and `~/.local/state/pi-history/history.sock` on macOS, and `PI_HISTORY_SOCKET` overrides it.
It runs on plain `node` 26 with only `node:` builtins, so a box needs no `npm install`.
`GET /v1/status` on the socket reports files, docs, bytes indexed, backfill percent, the newest entry, index lag p50 and p99 and the database size.

## Install

```sh
node packages/pi-history/install.mjs --ref <sha>                     # this box, systemd user unit pi-history.service
node packages/pi-history/install.mjs --ref <sha> --ssh <user@mac>    # the Mac, launchd agent com.sieun.pi-history
```

`install.mjs` exports the package at the commit into `~/.local/share/pi-history/release-<sha>`, points `current` at it, writes the unit or plist from `deploy/` and restarts the service.

## Tests

```sh
node --import tsx --test --test-force-exit test/*.test.ts
```
