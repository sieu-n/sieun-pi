# Source provenance and licenses

The owner approved a public, installable repository. Publication does not change a third party's license.
This record separates owner-authored source, adapted upstream work, and external applications.

## Import record

`config/source-inventory.json` records the initial source paths and import-time SHA-256 digests.
Those digests identify the initial copies, not current edited files or upstream authorship.
The initial import contained 51 skill definitions, an auxiliary Python helper, three Python packages, and the poteto Bun tools.

```text
Owner's custom setup         Public upstream source
  global skills                cursor/plugins/pstack
  account pool                 anaclumos/tokenmaxxing contracts
  app extensions               Prime Agent bundle excerpts
             \                 /
                 sieun-pi
                     |
              source installation
                     |
       private runtime state stays elsewhere
```

| Source group | Repository paths | Evidence and rights |
| --- | --- | --- |
| pstack skills and personas | Listed in `docs/attribution-pstack.json` | MIT, copyright 2026 Lauren Tan. Upstream source and license verified below. |
| Owner's Prime adaptations and custom skills | Local additions in `skills/`; `aside-browser`, `linear-ticket`, `resume-paused-sessions`, `spec-report`, `websearch`, and auxiliary `skills/skills` | Imported from the owner's setup. The copied Aside manual was excluded from the public source; the wrapper remains owner-authored material. |
| Owner's app extensions and Git guards | `components/virev/` | Imported from the owner's `auto-sns-agent` repository. Its history credits Sieun Park. The writing rules include adapted pstack guidance. |
| Owner's account pool | `components/pi-pool/` | Imported from the owner's maintained pool source. Tokenmaxxing-derived behavior and Prime bundle excerpts retain separate notices below. |
| Daily recap | `components/daily-recap/` | Imported from the owner's `auto-sns-agent/scripts/sieun/daily_recap` source. Its Git history credits Sieun Park. Sunsama client code remains a separately installed dependency. |
| Saved history and agent chat | `components/user-history/` | Imported from the owner's `prime-agent-user-history` baseline `289feca4885bbb0f92939a3ae5523007f00128ed`, with the UI update from `a069eb63da99b02ab13c3ccd2875dac0e1d20163` and a canonical saved-image display fix. Local history credits Sieun Park. See the component's `SOURCE.md`. |
| Agent identity and Prime context utilities | `utils/agent-identity.mjs`, `utils/prime-context.mjs` | Extracted from `auto-sns-agent/scripts/skills/agent-identity.mjs` and `derive-context.mjs`. Local Git history credits Sieun Park. Private incident examples were removed. |
| Setup and source tooling | `config/`, root manifests, `scripts/`, `tests/` | Owner-authored source and repository-specific work. The repository history records the changes. |

No repository-wide license was selected during this audit. The third-party licenses below apply to their stated portions.
They do not put unknown material or all owner-authored work under MIT.
A public checkout and working installer are not a substitute for an explicit license grant to reuse owner-authored work.

## Pstack

Upstream is [Lauren Tan's pstack in cursor/plugins](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack).
Its plugin manifest names Lauren Tan as author and MIT as the license.
Its [license](https://github.com/cursor/plugins/blob/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack/LICENSE) grants redistribution and modification when the copyright and permission notice remain.
The exact notice is retained in [`LICENSES/pstack-MIT.txt`](../LICENSES/pstack-MIT.txt).

The 2026-09-11 comparison found 123 upstream counterparts across 46 local skill directories, including both personas.
Two older `how` references were located in upstream history because current pstack no longer includes them.
Their per-file revision is recorded in the attribution map.
Thirty files were byte-identical to the current comparison revision.
`comment-sicko/SKILL.md` and `poteto-agent/SKILL.md` correspond to upstream files under `pstack/agents/`.
Other counterparts retain their paths under `pstack/skills/`.
The exact file mapping and upstream hashes are in [`attribution-pstack.json`](attribution-pstack.json).

The initial import did not record its upstream commit.
The comparison revision is evidence of origin, not a claim that the initial import used that revision.
Local changes replace Cursor calls with Prime's runtime, change model rules, and adapt the owner's workflows.
`unslop` also incorporates the owner's writing rules and app-specific plain-language guidance.
Its derivative guidance informs Virev's linter and the ticket writing checks; those local implementations are not represented as upstream pstack code.

## Prime Agent and Pi excerpts

`components/pi-pool/app/patch_prime_agent.py` embeds upstream bundle excerpts as patch anchors and replacement strings.
Its patch tests contain related fixtures.
Prime Agent's [v0.9.4 license](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.9.4/LICENSE) is MIT and names both copyright holders:

- Copyright (c) 2025 Mario Zechner.
- Copyright (c) 2026 Prime Intellect.

The full notice is retained in [`LICENSES/prime-agent-MIT.txt`](../LICENSES/prime-agent-MIT.txt).
Prime Agent and its installed dependencies remain external to this source repository.
The tested host is Prime Agent 0.9.4. This does not establish full upstream Pi compatibility.

## Tokenmaxxing

`vend.py` explicitly follows tokenmaxxing's credential refresh, account-store, expiry, and usage-cap behavior.
Local upstream source at `d4ed9c4a5564681b4b409918560c3582df1d5d16` identifies `anaclumos` as author and MIT as the license.
The public [upstream license](https://github.com/anaclumos/tokenmaxxing/blob/1a82259/LICENSE) names `Copyright (c) 2026 anaclumos`.
The full notice is retained in [`LICENSES/tokenmaxxing-MIT.txt`](../LICENSES/tokenmaxxing-MIT.txt) for adapted portions.
This does not claim that tokenmaxxing authored the whole pool.
Its application, credentials, and account stores are not distributed here.

Source licenses do not grant access to provider accounts or override provider service terms.
Account pooling must use accounts the operator is authorized to use and must comply with the provider's terms.

## Copied vendor documentation

The initial import included `skills/aside-browser/references/repl-api.md`, a snapshot of the Aside CLI manual.
No redistribution license was found for that manual.
[Aside's terms](https://aside.com/policy/terms), dated 2026-06-19, reserve its documentation under section 10 and limit the software license under section 3.
The owner-authored Python wrapper and factual API names do not establish permission to republish the manual.

The release source removes that snapshot. `skills/aside-browser/SKILL.md` now directs users to the installed `aside guide repl` command.
The wrapper still calls Aside's documented API; it does not distribute the browser or its manual.
The [public-release plan](public-release.md) preserves the earlier migration history privately and starts public history from reviewed source.
Do not copy the old manual into that public history or attach a permissive license to it.

## Distribution review

Keep [`NOTICE`](../NOTICE) with redistributed portions. It includes all three full license texts for packaged copies.
The `LICENSES` files preserve separate copies for source review.
The source license audit does not cover future imports automatically.
Review new components against their actual source before adding them to the inventory.

The release source removes the private Linear examples and the private email-editor spec reference.
The spec skill uses the owner-authored `references/evidence-driven-review.md` instead.
The Linear pipeline now uses operator-supplied configuration rather than private deployment instructions.
Its spec-page guidance requires synthetic public mock data and no private API examples.
Changes and remaining source checks are listed in [security and public artifacts](security.md).
The private archive and clean public history are separate repositories under the [public-release plan](public-release.md).
A source-only secret scan cannot establish rights or clear private examples in history.
