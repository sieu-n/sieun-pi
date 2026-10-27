# pi-pool-extension

This is Prime Agent's pi-pool extension, which was `components/pi-pool/app/extension` before the layout move.
It adds `/account`, the account line, login adoption, the 429 swap and the turn queue hooks to every Prime session.
`packages/pi-pool/install.py` ships `index.ts` into each pool release as `app/extension/index.ts`, and `~/.prime/agent/extensions/pi-pool` links there.
The pool's Python tests in `packages/pi-pool/test` drive it through `test/prime_extension.py`, and `native/` holds the regression tests against a copied Prime install.
It is deleted with the rest of `legacy/prime` after the switch, when `packages/pi-pool/src/pi` and `src/durable` serve every session.
