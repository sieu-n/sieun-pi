# pi-testkit

pi-testkit holds the test helpers every package in `packages/` uses.
`@sieun-pi/pi-testkit/faux` opens an in-process Pi runtime on a faux provider, so a test runs a whole turn with no model and no network.
It is a dev dependency only and never loads into a live session.

```sh
cd packages
node --import tsx --test --test-force-exit --test-isolation=none pi-testkit/test/faux.test.ts
```
