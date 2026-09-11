# Public source release

## Approved outcome

One maintained source package owns the custom Prime utilities. Application consumers use its public exports.
The public URL remains `https://github.com/sieu-n/sieun-pi`.
No account state, personal history or private examples enter the public source.

## Publication boundary

The first private migration imported internal examples and a vendor CLI manual without clear redistribution terms.
Deleting them from the latest tree does not remove them from Git history.
The public release therefore starts from the reviewed source tree, not the private migration history.
Preserve the original GitHub repository privately under a history/archive name before creating the public repository at the requested URL.
The original repository is preserved as the private `sieu-n/sieun-pi-private-history-20260911`.
A verified local bundle preserves all five original local and remote-tracking refs.
Keep the bundle and repository metadata before replacing the local Git directory.
Do not force-push private history away and claim that GitHub erased its objects.

Third-party pstack content keeps its verified MIT license and scoped attribution.
The Aside reference is read from the installed `aside guide repl` command instead of redistributed.
No blanket reuse license is invented for owner source.

## Source and runtime boundaries

```text
reviewed sieun-pi source
  ├─ global extensions and skills -> explicit profile installer
  ├─ shared utility exports      -> app dependency
  ├─ optional daily recap       -> reviewed external runtime copy
  └─ pool patch updater         -> two-file external runtime copy

private state and prior history -> stay outside public source
```

Profile apply, generated runtime writes and service activation are separate actions.
Existing Prime sessions and the history preview must stay running.
Rollback restores only receipt-owned targets whose current bytes still match the applied version.

## Remaining checks

1. Review and merge the scoped Virev cache fix with global project configuration.
2. Pass component and packed-artifact checks using production dependencies.
3. Apply reviewed profile changes against a fresh private-state baseline.
4. Publish the clean source history and prove anonymous Git access and installation.
5. Update and commit app consumers and remove old utility implementations through the shared-checkout workflow.
6. Read the app verification run and fix failures before declaring the full consolidation complete.
