# Source installation decision

Use candidate A's manifest-driven source links.
Both independent designs reached that recommendation. The design judge scored A 9/10 and B 8/10.
Source links keep the installed agent code tied to the maintained files.

```text
sieun-pi source
    -> individual installed source links
    -> Prime extensions, Python skills and account-pool CLI

Existing profile and pool directories
    -> credentials, settings, logs and session state stay in place
```

Keep candidate B's duplicate-load check and ordinary settings files.
Keep manifest executable modes and explicit external dependency checks.
New profiles receive a settings template. Existing settings remain byte-for-byte unchanged.
Prime's native kernel bootstrap installs linked Python skills editable.
Keep source links for skills, extensions and CLI code.

The pool no longer patches Prime's bundle. Prime Agent 0.9.5 ships as one compiled
binary, so the old patcher and its launchd updater were removed on 2026-09-23. The
account line, `/account` and login adoption now live in the pool extension, which uses
only the public extension API and needs nothing re-applied after a Prime update.
Do not move the standalone Claude skill-observability hook. It is not a Virev dependency.
The source-link investigator corrected that initial recommendation after checking its caller.

The judge identified one verification risk.
Changing HOME does not isolate the logged-in macOS Keychain.
Recovery tests must replace credential access with fixtures or deny access.
The real offline runtime check will only discover commands and skills, with no account commands or model request.
A fresh Prime process will verify installed source loading. Existing processes require reload or restart.
