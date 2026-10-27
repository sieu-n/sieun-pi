# Provenance of the vendored Prime runtime

pi-rlm vendors the MIT Python runtime and three bundled Python skills of Prime Agent.

The source is the installed release folder `~/.local/share/prime-agent/releases/0.9.8-daemon-fix.1-mem.4.2-s3int.9-crc.2-test-linux-x64-beb9504fee1c53ac7685acb6abf382ac046c017e70234e29839625acb446dcaa/` on us-metal02, which is Prime Agent `0.9.8-daemon-fix.1-mem.4.2-s3int.9-crc.2-test` (its `package.json` version).
The runtime package inside it is `prime-agent-runtime` version `0.1.0`.
The files were copied on 2026-10-27 without `__pycache__` folders.

## What was copied where

1. `prime-agent-runtime/` went to `pi-rlm/python/`, which holds `src/rlm` (repl, bash, harness, the skills loader `skill.py`, mcp, handoff), its tests, `pyproject.toml` and `uv.lock`.
2. `skills/goal`, `skills/compact` and `skills/edit` went to `pi-rlm/skills/`, which pi-rlm returns from `resources_discover`, so Pi lists them and the kernel pre-imports them.
3. The release `LICENSE` went to `pi-rlm/python/LICENSE`, and its text is repeated below.

The other bundled skills live with the part that answers their host requests: `agent-message` and `agent-observe` in `pi-rlm/agent-bus/skills`, `refine` with pi-harness and `rlm-heartbeat` with pi-host.

## Source file hashes

Each row is the SHA-256 of the file in the release folder before any change.

| Source file | SHA-256 |
|---|---|
| `LICENSE` | `b288615fb31dc504623582fb790a28e6d86bc2f5c1396845af555e43386da5a0` |
| `prime-agent-runtime/pyproject.toml` | `407c81e6a31f5c105d2a1f0833f5eb5b3f9320a12f336fe433d3b0c4a4e023c2` |
| `prime-agent-runtime/src/rlm/__init__.py` | `a166531d4a201b9fec049e275c5bb5c5d89e5d771f394fa3b37aaa840f12ca2b` |
| `prime-agent-runtime/src/rlm/_winjob.py` | `11243f5c7ba6527e70ed1f20a0e875a374b9013aca6fc4c70bcdb4653ea11296` |
| `prime-agent-runtime/src/rlm/bash.py` | `e0f41bd989a95c4d14b4b5bc4f92d1a16b435ae0c75655cb282f13ba39c5bbeb` |
| `prime-agent-runtime/src/rlm/handoff.py` | `971261881126c28a975e044a8f12d3c0ca80d808a8ff325b20e2458b540b8e19` |
| `prime-agent-runtime/src/rlm/harness.py` | `026130e79706c72a41947c0c86257c6a22b8dea4d1f61d57541622b2489ff9c1` |
| `prime-agent-runtime/src/rlm/mcp.py` | `1d4704b24a913e1e5d46547b3b0d011e2d5f9806139a046eef80983169d3bf0d` |
| `prime-agent-runtime/src/rlm/mcp_base.py` | `0f1e5b1d66806bf4af12b1ef81f13453d5e9413846d3e5b4bb254f0c40aec4cb` |
| `prime-agent-runtime/src/rlm/repl.md` | `0e8d88c02de7bdda1add8cafccb4fe316859a7fd4cbbf2d4c77ba2044d12a182` |
| `prime-agent-runtime/src/rlm/repl.py` | `86daa66348c80d89c76ec3c7366f2f59c768f29edb73f288dfec8e7cd97d8539` |
| `prime-agent-runtime/src/rlm/skill.py` | `23f1ecba340b24a4e75880437f33fa72fbd510a2da496a87a9d033fc66b92a7a` |
| `prime-agent-runtime/test/test_agent_message_skill.py` | `bb7ef35865a6a053264811cc047f6e594e7d9a5e6c06af1dde903f85799b17a9` |
| `prime-agent-runtime/test/test_bash.py` | `d48473fbac2963e7c90141eabcbfcbc5b142ffa3f9c32463ae6902257266f581` |
| `prime-agent-runtime/test/test_create_session.py` | `cdebb9378df0f6cb826a39f1dd04bfb8bb3bc08179769725dd1dd551fa0b5a31` |
| `prime-agent-runtime/test/test_harness.py` | `1d31ce512c9db8893e5c1473c503a129f934e2d70867c9cef0592c42945b0e77` |
| `prime-agent-runtime/test/test_lazy_restore.py` | `bcf1fce3c2b7ae2e025686c950f68fe1a261568156b21de21a7e28ed24f9c04c` |
| `prime-agent-runtime/test/test_mcp.py` | `6d0592f146056eb1bbf6ecbf67bfb85d26716b5833b1ac312057dabb649e43a8` |
| `prime-agent-runtime/test/test_mcp_base.py` | `ad3f4c1aa3c49e352bb89af91e053770f3d8bf718e88e9717880d16b0cd2202f` |
| `prime-agent-runtime/test/test_repl.py` | `dee19032041ca73a29c090c0098893bc5ab8d23ffdc3ff918c11d42a6fbf235e` |
| `prime-agent-runtime/test/test_subagent_registry.py` | `6073949310f8d0bddd1e1b2678f203140d712a1626095ac2412d45a947369da5` |
| `prime-agent-runtime/test/test_winjob.py` | `a25a819237fec6c6b866386f44f7be51f3eec1e6abc74848db9d9616002042fe` |
| `prime-agent-runtime/uv.lock` | `9f1c9bd7c6597a9ebe78d1be524853fbfd70842800b63cfc5894c19591dc5457` |
| `skills/compact/SKILL.md` | `25697c118cbc43364b072c0edde49cee995f6fe94e1f9ff72eaa81e8479eed25` |
| `skills/compact/pyproject.toml` | `1d2c7e380700da31e0a1fd6dda95584aae90bb099f6c728a3506875102174f71` |
| `skills/compact/src/compact/__init__.py` | `126ee36620089cb9a9cf16e88b9bf36c41b5feeb3e70a15bd9bd67d041c3e0dc` |
| `skills/edit/.gitignore` | `52899f7caa3760b4e8e82d397fe3544a3d0a99cce4a5e928de00b7db45589a3d` |
| `skills/edit/SKILL.md` | `5e687f0d6fc45a48b5ffa7285e342e07b2595c00481c8dcd028c3a8932f67d90` |
| `skills/edit/pyproject.toml` | `fcca6dcb584499a3b54b29c11da5e9bb3372e13b3779b25f2dd6f98a45668f90` |
| `skills/edit/src/edit/__init__.py` | `b1986c8c72198395656b6b2028bf3b51d798dab7eb0d923e2ce781c00186498f` |
| `skills/goal/SKILL.md` | `da1694a20929517b59485e61e95ffcd292d67b30826155ba8a8831f9afd4dbf1` |
| `skills/goal/pyproject.toml` | `49f32e237c446dcf03d5c10def022b0a7bb534fb2311ac3d7f4b316db9c1cf52` |
| `skills/goal/src/goal/__init__.py` | `a96fcee0bbba5b232b40bcb6b7cf679747bc91d5baa739b956237ee75036608d` |

## Changes to vendored files

1. `python/src/rlm/repl.py` has sieun-pi's kernel revive guard (prime-agent#3447) applied from `components/watchdog/repl-guard.patch` with `patch --forward -p0`. A dill revive no longer reopens a saved write-mode file handle and truncates its target. The watchdog used to re-apply this patch to Prime's installed copy after each update, and pi-rlm owns this copy, so the patch lives here. The patched file's SHA-256 is `d583f2877d8baca0a1197df70818431e22b53160335c897c5b2b294196678a04`.

2. `python/src/rlm/harness.py` takes a cross-process lock for every write, from pi-harness's `harness-lock.patch` (`/home/sieun/work/pi-migration-build/step-4/harness-py-lock/`). A `_FileLock` class takes `<file>.lock` with the protocol of pi-harness's `lock.ts`, user-history's `locked-json.ts` and prime-sync's `LedgerLock`, and the five mutators reload the file under it before they change it. Before the patch, 8 writers plus prime-sync lost entries with the mtime check alone. The patched file's SHA-256 is `77155ad22abeca3927398ccc2403d63d41c422fdd85a7c08f79f7ee285164cec`.
3. `python/test/test_harness.py` saves twice more in `test_search_discounts_common_terms_and_keeps_frequency_ties`, because a create now reloads from disk. The patched file's SHA-256 is `a230b66e6974594a8522e46c9d303616239b1286860417e0bf62fdcad157322f`, and the 54 harness tests pass with `uv run --offline --with pytest pytest test/test_harness.py`.

No other vendored file differs from its source.

## License

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2026 Prime Intellect

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
