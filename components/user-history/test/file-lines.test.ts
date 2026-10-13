import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const components = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CODE = /\.(ts|mts|mjs|js|svelte|py)$/;
const SKIP = new Set(["node_modules", "__pycache__", "fixtures", "dist"]);

function codeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return codeFiles(path);
    return CODE.test(entry.name) ? [path] : [];
  });
}

test("no user-history or pi-pool code file is over the 1,000-line limit", () => {
  const over = ["user-history", "pi-pool"].flatMap(name => codeFiles(join(components, name)))
    .map(path => ({ file: relative(components, path), lines: readFileSync(path, "utf8").split("\n").length - 1 }))
    .filter(({ lines }) => lines > 1000);
  assert.deepEqual(over, []);
});
