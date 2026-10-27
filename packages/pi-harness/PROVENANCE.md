# Provenance of the code pi-harness takes from Prime Agent

pi-harness rebuilds Prime Agent's continual harness host code and ships Prime's `refine` skill.
Both come from the MIT-licensed Prime Agent release `0.9.8-daemon-fix.1-mem.4.2-s3int.9-crc.2-test`, installed on us-metal02 at `~/.local/share/prime-agent/releases/0.9.8-daemon-fix.1-mem.4.2-s3int.9-crc.2-test-linux-x64-beb9504f.../`.
The work was done on 2026-10-27.

## What came from where

1. `skills/refine/` is a copy of the release's `skills/refine/` (`SKILL.md`, `pyproject.toml`, `src/refine/__init__.py`), unchanged.
2. `src/core/prompts.ts` holds the planner prompt (`_Fn`) and the auto-refine review prompt (`SFn`), copied as text from the JavaScript bundle inside the release's `prime-agent` binary.
3. `src/core/digest.ts`, `src/core/refine.ts`, `src/core/conversation.ts` and `src/core/store.ts` are TypeScript rewrites of the bundle's functions `qFn`, `jFn`, `JFn`, `GFn`, `VFn`, `YFn`, `UFn`, `eUn`, `IZs`, `iUn`, `mZs`, `EZs`, `gZs`, `BR`, `get`, `vI` and `$Fn`, and of the host's `_nextHarnessDigestMessage`, `_maybeAutoRefine` and `handleRefineHostRequest` methods.
4. `src/core/store.ts` keeps the file format and path rules of the release's `prime-agent-runtime/src/rlm/harness.py`.
5. `test/fixtures/prime-parity.json` is the output of the bundle's own functions on `test/fixtures/global` and `test/fixtures/local`, made by the generator in `~/work/pi-migration-build/step-4/parity/`.

## Source file hashes

Each row is the SHA-256 of the file in the release folder.

| Source file | SHA-256 |
|---|---|
| `prime-agent` | `132e41696837dba42f8c50d2fc42bfed255994b8c7cdc5d8c7fdfb888f6d9ebf` |
| `skills/refine/SKILL.md` | `048b0e5a3df1d8d5b17ad2650d08956fd2fd92bf60f9d2d02430a87aca2e6173` |
| `skills/refine/pyproject.toml` | `f482f85516873881b63743e23db6bd8a966ed7c5a2137bff7537675b6ebfb8b8` |
| `skills/refine/src/refine/__init__.py` | `00737a6e2d3951dff6df6f4eb02578beccfe81caccbc09cfeb1f1ac6bb618844` |
| `prime-agent-runtime/src/rlm/harness.py` | `026130e79706c72a41947c0c86257c6a22b8dea4d1f61d57541622b2489ff9c1` |

## License

The release's `LICENSE` reads as follows.

```
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
