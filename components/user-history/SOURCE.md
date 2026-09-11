# Source provenance

This component first came from `prime-agent-user-history` at commit `289feca4885bbb0f92939a3ae5523007f00128ed`. The UI update integrates the same source at frozen commit `a069eb63da99b02ab13c3ccd2875dac0e1d20163`.

The import includes tracked source, tests, documentation and configuration. It excludes histories, credentials, installed dependencies, caches and test artifacts. The original checkout stays unchanged.

Consolidation replaces the machine-local Prime Agent dependency with the official 0.9.4 release. Tests use `process.execPath` and resolve the native provider library as an explicit development dependency from the same release. The component keeps both commands, the daemon-socket flag and the original relative import layout.

The source checkout had no tracked license file. The owner authorized public distribution but has not selected a blanket reuse license. No general reuse license is granted unless the root licensing states otherwise. See the root `NOTICE` and the dependency licenses. Prime Agent and all other dependencies keep their own licenses; this component does not vendor their source.

## Initial consolidation checks

- `npm run typecheck` passed on Node v26.8.1.
- All 45 unit and HTTP tests passed on Node v26.8.1 and v25.9.0.
- Both native command tests passed on Node v26.8.1 and v25.9.0 with the packaged Prime Agent 0.9.4 CLI.
- Native checks used synthetic homes, sessions and explicit test-owned daemon sockets. Snapshot checks kept all 134 saved entries unchanged and made zero model calls. Chat checks used two synthetic provider calls and zero real model calls; saved bytes and worker identities stayed unchanged.
- At initial consolidation, all eight production files under `extension/` and `src/` matched the first source baseline byte for byte.
- A component `npm pack --dry-run` included only the runtime source and package documentation. No private histories, test artifacts, caches or installed dependencies entered the package.

This migration did not repeat the source author's browser review or change live extension registration. Native tests used a test-only opener instead of opening Aside.

## UI integration checks

The frozen UI patch from `a069eb63da99b02ab13c3ccd2875dac0e1d20163` was merged in memory against the first baseline. All 13 patched files matched the frozen source before canonical portability changes were retained.

- The update adds `src/chat-client.ts`, `src/chat-images.ts` and image tests. Nine runtime files under `extension/` and `src/` match the frozen UI source byte for byte. A later review fix in `src/chat-backend.ts` restores `[Saved image]` placeholders for native images that cannot be previewed.
- Canonical package metadata, dependency lock, SDK resolution, Node executable selection, snapshot native test setup and whole-package registration remain unchanged.
- `npm run typecheck` passed on Node v26.8.1. All 77 unit/HTTP tests and both native command tests passed on Node v26.8.1 and v25.9.0.
- Native chat checks used three synthetic provider calls and zero real model calls. They verified native model selection, usage totals, unchanged image bytes, queued follow-ups, unchanged saved history and worker identities after viewer close.
- The snapshot retained all 134 saved entries and made zero model calls. Its captured page remained script-free.
- Native tests used synthetic homes and explicit test-owned daemon sockets. They did not change the user's live profile or working sessions.

The root session owns browser review, package verification and live activation. This integration did not repeat the source author's Aside review.

Native model changes also update Prime Agent's default model and provider. The UI and README disclose this side effect. Session replacement, idle-state and model changes can race between native checks and operations; the integration adds no atomic protection.

## Saved image display regression

The integrated UI initially hid image-only saved messages when every image failed preview validation. A native regression fixture reproduced the missing entry before the fix.

The backend now keeps one `[Saved image]` placeholder for each omitted native image block. Unsupported MIME types, corrupt data, oversized images and images beyond the preview count remain excluded from previews. Upload and preview limits are unchanged, and saved history bytes are never rewritten by this projection.

The migration does not fix the native terminal session-replacement race. See the warning under "Native architecture" in `README.md`.
