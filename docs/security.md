# Security and public artifacts

## Trust and runtime data

These extensions and skills run with the operator's user permissions. They are not a security sandbox.
Review the source, install plan, provider setup, and enabled MCP servers before use.
Use a disposable profile and project for installation checks.
Do not run untrusted instructions or repositories against accounts with production access.

```text
Reviewed source checkout
  -> installer plan and approval
  -> linked skills and extensions
  -> Prime / Aside / provider accounts

Private runtime data
  -> profile, account stores, logs and receipts
  -> never a source file or release artifact
```

| Component | Sensitive behavior |
| --- | --- |
| `scripts/manage.py` | Creates source links and setup files. Receipts and replacement backups stay outside the checkout. Existing settings and authentication files are not installation payloads. |
| `components/pi-pool/vend.py` | Reads parked credentials and macOS Keychain, contacts OAuth endpoints, and writes refresh rotations to private account stores. Its stdout is an access token. Do not paste or capture that output in public reports. |
| Pool patcher and updater | Change the installed Prime bundle. The updater uses a generated runtime copy outside the source checkout. Review it separately from source-link installation. |
| `aside-browser` | Controls the real logged-in browser. Page contents, screenshots, downloads, and actions can expose or change account data. |
| Saved history and agent chat | Exposes selected private sessions to Aside over random loopback URLs. Chat can send native prompts. Do not share the URL. Local processes and browser-managed copies are outside that protection. |
| Daily recap | Can read local commits, focus data, token-use summaries, and a configured Sunsama cookie store. It can send selected content to a model and post to Slack. Review inputs and destination before enabling it. |
| `linear-ticket` | Uploads supplied assets and changes the selected Linear issue when publishing is called. Local checks do not publish. |
| Session recovery and fleet health | Read private session data. Operational repair can resume, message, or abort sessions. These are not harmless health probes. |
| Poteto's `watch-pr` and `orch` | Use the operator's GitHub or Graphite credentials for repository work. Local tests use fixtures instead. |

Keep these outside Git and release archives:

- API keys, OAuth tokens, authentication files, and Keychain exports.
- Account indexes, credential files, refresh journals, locks, and usage state.
- Private Prime settings, session transcripts, learned memories, and session-derived indexes.
- Browser profiles, snapshots, screenshots, downloads, and private ticket attachments.
- Daily recap configuration, copied cookie stores, generated reports, and previous-run state.
- `.test-artifacts/`, including generated credentials, loopback access URLs, and synthetic sessions.
- Installer plans and receipts with local paths, backup copies, and updater logs.
- Installed dependencies, virtual environments, build output, bytecode, and retired implementations.

Public OAuth client IDs in the pool are protocol identifiers, not client secrets.
They do not authorize use of another person's account or override provider terms.

## Public-artifact review

The 2026-09-11 review began at `ba406b5` with 224 tracked files.
No tracked path matched the runtime-data, dependency, build-output, or bytecode patterns checked in that review.
This is a filename check, not proof that file contents contain no secrets.
The coordinating release process must scan current content, packaged output, and all Git history that will become public.

The final 2026-09-11 package listing contained 271 files and included `NOTICE`, all three `LICENSES` copies, and the pstack attribution map.
It excluded the removed private documents and `.test-artifacts/`.
The package text scan found no absolute owner checkout path.
These checks do not replace the release secret scan.

The release preparation made these source changes:

| Initial-import paths | Public source outcome |
| --- | --- |
| `skills/aside-browser/references/repl-api.md` | Removed. The skill directs users to the installed `aside guide repl` command. No license is claimed for the vendor manual. |
| `skills/linear-ticket/references/pipeline.md` and `spec-page.md` | Removed private deployment details and internal example links. Public mock guidance requires synthetic records and project-supplied configuration. |
| `skills/linear-ticket/references/example-vir-371.md` and `example-after-openapi.json` | Removed the internal design example, social-profile data, and media references. |
| `skills/spec-report/references/approved-email-editor-spec.md` | Removed the private spec reference. The skill now uses owner-authored `evidence-driven-review.md`. |
| `components/virev/repo-hooks/agent-guards.mjs` | Removed the copied app deployment helper. Project policy stays separate from global behavior. |

### Account examples

The pool test fixture now uses synthetic account UUIDs and `example.test` addresses.
The pool README also uses `example.test` command examples.
The original fixture Git blob `d268fd09fb0349212d0ed68e21ffa2070de3dd0f` and old README stay only in the private history archive.

Poteto playbooks resolve helper and sibling-skill paths from the loaded skill directory.
The source-path tests check those targets and the copied plan skeleton.
This does not prove every playbook operation or its external service access.

Paths in `config/source-inventory.json` are historical source labels, not runtime dependencies.
Generic `~/.prime/agent` and `/tmp/<slug>` examples are not credentials.
App-specific rules must remain opt-in for the selected project rather than silently becoming global policy.
A public repository does not make its linked private services available to other users.

Deleting a file in the newest commit does not remove its old Git blobs.
The vendor manual, private examples, deployment helper, and account-test fixture were committed in `91740d9b985de44109f40ced3dc6ee48a160e762`.
The copied Aside manual is Git blob `3d552904ed76d063b530325f3a789f5db00bd8ba`.
The other data-review paths can be traced from that commit without reproducing their contents here.
The [public-release plan](public-release.md) keeps the original GitHub repository and its history private.
The public repository starts with the reviewed source tree, without importing old refs or objects.
This does not claim that deleting files or force-pushing erases GitHub's old objects.
Before publication, verify the private archive and inspect every ref in the new public repository.
If a secret is found, revoke or rotate it before publication.
A source license does not grant rights to a third party's data.

## External dependencies

| Requirement | Scope |
| --- | --- |
| Prime Agent 0.9.4 | Tested extension host and Python skill runtime. Installed separately for interactive use. |
| Node.js, npm, Python 3.11+, uv, Bun | Build and check tools. Use the versions required by the current install guide. |
| Aside and its MCP server | Browser calls. The example settings use an `aside` executable on `PATH`; the wrapper also supports `ASIDE_CLI`. |
| Tokenmaxxing stores and macOS Keychain | Account-pool operation. The source installer does not seed account stores or install credentials. |
| Virev API key | Web search. Requests use `api.virev.ai` unless configured otherwise. Search can incur charges. |
| Linear, GitHub, Graphite, and local wiki services | Only the workflows that call them. A source check does not prove service access. |
| Daily recap integrations | Explicit Slack, repository, Sunsama, and focus-data configuration. Empty service inputs remain disabled. |

Lockfiles use public package sources and repository-relative Python package paths.
The Prime Agent and TUI development packages use pinned official release tarballs with lockfile integrity hashes.
Do not publish `node_modules`, `.venv`, or a copied installed Prime bundle as source artifacts.
Package checks must include `NOTICE`, which contains the full third-party license texts, and the provenance files linked by the docs.
Review dependency licenses and contents separately if a future release bundles them.

## Dependency audit

`npm audit --json` was rerun on 2026-09-11 against the locked dependencies.
It returned exit code 1 and reported two high-severity dependency entries, `extract-zip` and its direct parent `prime-agent`.
Both trace to `extract-zip` 2.0.1 and these two advisories:

- [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), unvalidated symlink path traversal.
- [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3), arbitrary file writes through symlink archive entries.

npm reports no available fix. The audit reports no critical findings.
The custom source installer does not extract ZIP archives.
That does not prove the host is safe; the installed Prime application also uses this dependency.
Avoid untrusted archives and update the host when a verified fix is available.
The finding is documented rather than suppressed or replaced with an unverified fork.
Rerun the audit after dependency changes.
