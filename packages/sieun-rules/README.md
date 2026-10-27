# rules

The Pi tests and the pi-host check for sieun-pi's Prime extensions, which load unchanged on upstream Pi: `components/global-rules`, `components/claude-rules` and `components/user-history/extension`.
`pi-host/extensions.json` lists all three, so every pi-host session loads them next to pi-rlm.
The extension code stays in its own component, because the live Prime loads the same files and prime-sync ships them.

## What runs on Pi

1. The global-rules tool_call guards refuse transcript reads outside the family, sends without an approved OWNER_OK, resource caps and history rewrites in sieun-pi.
2. The global-rules cell prelude loads `kernel-guard.py`, `kernel-read.py`, `kernel-own.py` and `kernel-cwd.py` into pi-rlm's kernel, as on Prime.
3. claude-rules puts a repo's unscoped `.claude/rules` first in every request and appends a scoped rule to the result that touched its file.
4. The user-history extension registers `chat_board`, `tell_owner` and the chat and job hooks, and it reads boards from `<Pi agent dir>/browser-chat` unless `--agent-chat-data-dir` names another.
5. Pi reads `config/AGENTS.md` as `<agent dir>/AGENTS.md`, so the global rules reach the system prompt once the install links it there.

## Files

| File | What it holds |
|---|---|
| `test/paths.test.ts` | The Prime and Pi session layouts in `global-rules/paths.ts` and `send-log.ts`, and `kernel-read.py --judge` refusing Prime and Pi transcripts for a Pi session. |
| `test/extensions.test.ts` | One in-process pi-host with pi-rlm and the three extensions: the kernel guards load, a Pi transcript read and a send are refused, claude-rules reaches the context and `chat_board` writes and reads a board. |
| `rig/scripted.ts` | The `script` provider, which runs the tool call a `TOOL {...}` message names, so a check drives real tool calls without a model. |
| `rig/check.ts` | The pi-host check over the socket, with every guard case, `OWNER_OK`, claude-rules, `AGENTS.md`, `chat_board` and an `rlm.spawn` child. |

## Run

```sh
cd packages
node --import tsx --test --test-force-exit sieun-rules/test/*.test.ts
RULES_RIG_DIR=<scratch dir> RULES_RIG_OUT=<evidence dir> RULES_RIG_OTHER_TRANSCRIPT=<a transcript outside this family> \
  PI_RLM_PYTHON=<python with dill and tyro> node --import tsx sieun-rules/rig/check.ts
```

The check starts pi-host with a clean environment, so no Prime kernel variable reaches it, and it refuses each transcript read before a byte is read.
