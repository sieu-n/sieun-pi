# pi-history

pi-history keeps a full-text index of every Prime and Pi session transcript on one box and answers searches on a unix socket.
The contract between its parts is `~/work/chat-history-search/API.md` on us-metal02.

Run the service from the package folder with `node src/main.ts`, and pass `--db <path>` to use another database file.
It runs on plain `node` 26 with only `node:` builtins, so a box needs no `npm install`.
