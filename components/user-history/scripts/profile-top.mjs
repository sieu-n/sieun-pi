#!/usr/bin/env node
import { readFileSync } from "node:fs";

// Prints the top entries of a .cpuprofile: self time per function, per file and per nearest chat source frame, and how busy the main thread was.
// Usage: node scripts/profile-top.mjs <file.cpuprofile> [count]
const [path, countText = "5"] = process.argv.slice(2);
const count = Number(countText);
const profile = JSON.parse(readFileSync(path, "utf8"));
const byId = new Map(profile.nodes.map(node => [node.id, node]));
const parent = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id])));
const self = new Map();
profile.samples.forEach((id, index) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)));
const total = profile.endTime - profile.startTime;
const short = url => url.replace(/^file:\/\/.*?\/(node_modules|components\/user-history)\//, "$1/");
const label = ({ callFrame }) => `${callFrame.functionName || "(anonymous)"} ${short(callFrame.url) || "(native)"}:${callFrame.lineNumber + 1}`;
const sourceFrame = id => {
  for (let at = id; at !== undefined; at = parent.get(at)) if (/\/components\/user-history\/src\//.test(byId.get(at).callFrame.url)) return label(byId.get(at));
  return "(no chat source frame)";
};
const functions = new Map();
const files = new Map();
const sources = new Map();
const add = (map, key, micros) => map.set(key, (map.get(key) ?? 0) + micros);
let busy = 0;
for (const [id, micros] of self) {
  const node = byId.get(id);
  if (node.callFrame.functionName === "(idle)") continue;
  busy += micros;
  add(functions, label(node), micros);
  add(files, short(node.callFrame.url) || node.callFrame.functionName, micros);
  add(sources, sourceFrame(id), micros);
}
const rows = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, count)
  .map(([key, micros]) => `${(micros / 1000).toFixed(0).padStart(8)} ms ${(micros / busy * 100).toFixed(1).padStart(5)}% of busy  ${key}`);
process.stdout.write([path, `recorded ${(total / 1e6).toFixed(1)} s, main thread busy ${(busy / 1e6).toFixed(1)} s (${(busy / total * 100).toFixed(1)}%)`,
  "self time by function:", ...rows(functions), "self time by file:", ...rows(files), "self time by nearest chat source frame:", ...rows(sources)].join("\n") + "\n");
