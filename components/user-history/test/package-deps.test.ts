import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("the packed sieun-pi carries every chat dependency, so an npm install needs no install inside components/user-history", () => {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { dependencies: Record<string, string> };
  const component = read(join(import.meta.dirname, "..", "package.json")).dependencies;
  const root = read(join(import.meta.dirname, "..", "..", "..", "package.json")).dependencies;
  for (const [name, spec] of Object.entries(component)) assert.equal(root[name], spec, `root package.json lists ${name} ${spec}`);
});
