import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "svelte/compiler";

type Node = { type: string; name?: string; data?: string; [key: string]: unknown };

function walk(node: unknown, visit: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  const value = node as Node;
  if (typeof value.type === "string") visit(value);
  for (const key of Object.keys(value)) if (key !== "parent") walk(value[key], visit);
}

const contains = (root: unknown, match: (node: Node) => boolean): boolean => {
  let found = false;
  walk(root, node => { if (match(node)) found = true; });
  return found;
};

test("sidebar: a chat row in the Show details view shows its progress steps and priority bars, like a thread row", async () => {
  const source = await readFile(new URL("../src/client/Sidebar.svelte", import.meta.url), "utf8");
  const ast = parse(source, { modern: true });
  const chatBranches: Node[] = [];
  walk(ast.fragment, node => {
    const condition = node.test as { start: number; end: number } | undefined;
    if (node.type === "IfBlock" && condition && source.slice(condition.start, condition.end) === "row.chat" && contains(node.consequent, child => child.type === "Text" && String(child.data).includes("No plan yet"))) chatBranches.push(node);
  });
  assert.equal(chatBranches.length, 1, "one details-view branch renders the chat row line");
  for (const component of ["ProgressSteps", "PriorityBars"])
    assert(contains(chatBranches[0]!.consequent, child => child.type === "Component" && child.name === component), `the chat row line renders ${component}`);
});
