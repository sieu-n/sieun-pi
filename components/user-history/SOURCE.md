# Source provenance

This component came from `prime-agent-user-history` at commit `289feca4885bbb0f92939a3ae5523007f00128ed`.

The import includes tracked source, tests, documentation and configuration. It excludes histories, credentials, installed dependencies, caches and test artifacts. The original checkout stays unchanged.

Consolidation replaces the machine-local Prime Agent dependency with the official 0.9.4 release. Tests use `process.execPath` and resolve the native provider library as an explicit development dependency from the same release. The component keeps both commands, the daemon-socket flag and the original relative import layout.

The source checkout had no tracked license file. The owner authorized public distribution but has not selected a blanket reuse license. No general reuse license is granted unless the root licensing states otherwise. See the root `NOTICE` and the dependency licenses. Prime Agent and all other dependencies keep their own licenses; this component does not vendor their source.

## Consolidation checks

- `npm run typecheck` passed on Node v26.8.1.
- All 45 unit and HTTP tests passed on Node v26.8.1 and v25.9.0.
- Both native command tests passed on Node v26.8.1 and v25.9.0 with the packaged Prime Agent 0.9.4 CLI.
- Native checks used synthetic homes, sessions and explicit test-owned daemon sockets. Snapshot checks kept all 134 saved entries unchanged and made zero model calls. Chat checks used two synthetic provider calls and zero real model calls; saved bytes and worker identities stayed unchanged.
- All eight production files under `extension/` and `src/` match the source baseline byte for byte.
- A component `npm pack --dry-run` included only the runtime source and package documentation. No private histories, test artifacts, caches or installed dependencies entered the package.

This migration did not repeat the source author's browser review or change live extension registration. Native tests used a test-only opener instead of opening Aside.

The migration does not fix the native terminal session-replacement race. See the warning under "Native architecture" in `README.md`.
