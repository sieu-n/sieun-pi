// @ts-nocheck: a copy of an untyped auto-sns-agent script; wiki-write.ts calls staleWrite only, typed in stale-base.d.mts.
// stale-base.mjs, from auto-sns-agent scripts/repo/agent/stale-base.mjs: the older version of a file that a working copy was copied from, when nothing recorded it.
//
// A working copy in the shared checkout can hold an old version of a file, alone or with an edit, and no edit-base
// record (edit-base.mjs) says so: a sync, a test or a tool wrote back bytes it had read before a land moved the tip.
// Committing that copy whole undoes what landed. On 2026-10-18 sync-tree.mjs --orphans cleared such copies of six
// apps/infra/metal/gates files, apps/crawler-v3/scripts/test-ci.sh and .github/workflows/land.yml, and
// scripts/ci/ci-scope.mjs held a copy written at 08:50Z, 247 lines short of HEAD, after f21b274d63 and e2e34d72ea.
//
// The base is the version in HEAD's history of the path whose lines differ least from the copy, the newest one on a
// tie. It counts when it is older than HEAD's version and the copy, written before a commit landed, lacks a line
// that commit brought in. commit.mjs then merges the copy onto HEAD's version with that base, as it does for a
// recorded edit base. A copy written later that still holds lines of the base that HEAD's version lacks only warns:
// a deliberate revert looks the same, and replaying the 24 h of sieun/dev commits to 2026-10-18 21:00Z as edits found
// such reverts, 782dc31699 (of 8e45b7846c) and 9a940954af (of 0a999a3a8d), that a merge would have undone.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// staleBase walks the history of one path with git log. On us-metal02's 17,887 commits that walk took 2.16 s per path
// with a commit-graph that held no changed-path Bloom filters, and 0.065 s with them. On 2026-10-24 four "take in
// staging" commits of 553 to 1948 files ran it once per file at about one core each, the oldest for over 52 min, and a
// moved tip makes commit.mjs start the pass again. So the first walk in a process writes the filters when the
// commit-graph lacks them, which took 16 to 22 s per repo there, and later commit-graph writes keep them.
// A commit the graph does not hold gets no filter either, and nothing else writes the graph here (maintenance.auto is
// off): on 2026-11-02 the 9,239 commits since the last write on 10-28 took a one-path log from 0.1 s to 5.7 s. So the
// first walk also adds a split layer when the graph lacks HEAD. git's own commit-graph-chain.lock keeps two writers
// apart, and the loser's write fails and is reported, so its walks run as before.
const bloomChecked = new Set();

// The files of the commit-graph in `info` (an objects/info folder), oldest layer first; git reads a single
// commit-graph file before a split chain.
function graphFiles(info) {
  const single = path.join(info, 'commit-graph'), chain = path.join(info, 'commit-graphs', 'commit-graph-chain');
  return existsSync(single) || !existsSync(chain)
    ? [single]
    : readFileSync(chain, 'utf8').split('\n').filter(Boolean).map((h) => path.join(info, 'commit-graphs', `graph-${h}.graph`));
}

// The byte offset of chunk `id` in the commit-graph file `b`, or null.
function chunkAt(b, id) {
  for (let i = 0; i < b[6]; i++) if (b.toString('latin1', 8 + 12 * i, 12 + 12 * i) === id) return Number(b.readBigUInt64BE(12 + 12 * i));
  return null;
}

// True when every layer of the commit-graph in `info` has a BDAT chunk.
export function graphHasBloom(info) {
  const files = graphFiles(info);
  if (!files.every(existsSync)) return false;
  return files.every((f) => chunkAt(readFileSync(f), 'BDAT') !== null);
}

// True when a layer of the commit-graph in `info` holds commit `oid`, found through its OIDF fanout and OIDL list.
export function graphHolds(info, oid) {
  const want = Buffer.from(oid, 'hex');
  return graphFiles(info).some((f) => {
    if (!existsSync(f)) return false;
    const b = readFileSync(f);
    const fanout = chunkAt(b, 'OIDF'), lookup = chunkAt(b, 'OIDL'), size = b[5] === 2 ? 32 : 20;
    if (fanout === null || lookup === null || want.length !== size) return false;
    let lo = want[0] ? b.readUInt32BE(fanout + 4 * (want[0] - 1)) : 0, hi = b.readUInt32BE(fanout + 4 * want[0]);
    while (lo < hi) {
      const mid = (lo + hi) >> 1, cmp = b.compare(want, 0, size, lookup + mid * size, lookup + (mid + 1) * size);
      if (cmp === 0) return true;
      if (cmp > 0) hi = mid; else lo = mid + 1;
    }
    return false;
  });
}

// The objects/info folder of each runner, read once: commit.mjs calls this for every file it commits.
const infoOf = new WeakMap();
export function ensureChangedPaths(run) {
  if (!infoOf.has(run)) {
    const r = run(['rev-parse', '--path-format=absolute', '--git-path', 'objects/info']);
    if (r.status !== 0) return;
    infoOf.set(run, r.stdout.trim());
  }
  const info = infoOf.get(run);
  if (bloomChecked.has(info)) return;
  bloomChecked.add(info);
  const write = (args) => {
    const r = run(['commit-graph', 'write', '--reachable', ...args, '--changed-paths', '--no-progress']);
    if (r.status !== 0) process.stderr.write(`stale-base: git commit-graph write failed, so history walks of commits past the graph stay slow: ${r.stderr.trim()}\n`);
  };
  if (!graphHasBloom(info)) return write([]);
  const head = run(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (head.status === 0 && !graphHolds(info, head.stdout.trim())) write(['--split']);
}

const lineCounts = (text) => {
  const m = new Map();
  for (const line of text.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
  return m;
};
// Lines of a, as a multiset, that b lacks.
function missing(a, b) {
  const out = new Map();
  for (const [line, n] of a) {
    const k = n - (b.get(line) ?? 0);
    if (k > 0) out.set(line, k);
  }
  return out;
}
const size = (m) => { let n = 0; for (const k of m.values()) n += k; return n; };
const distance = (a, b) => size(missing(a, b)) + size(missing(b, a));

// Blob id -> text for every id, in one git cat-file --batch; binary blobs (a NUL byte) are left out.
function readBlobs(run, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const r = run(['cat-file', '--batch'], { input: ids.join('\n') + '\n', encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`git cat-file --batch: ${String(r.stderr).trim()}`);
  const buf = r.stdout;
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const [id, type, len] = buf.subarray(at, nl).toString().split(' ');
    if (type === 'missing') { at = nl + 1; continue; }
    const body = buf.subarray(nl + 1, nl + 1 + Number(len));
    if (!body.includes(0)) out.set(id, body.toString('utf8'));
    at = nl + 1 + Number(len) + 1;
  }
  return out;
}

/**
 * { entry, tip, inferred: true, warnOnly } for p, in edit-base.mjs's shape: entry is "<mode> <blob>" of the version the
 * working copy `own` was copied from and tip the newest commit holding it; null when `own` reads as an edit of HEAD's
 * version `tipCopy`. warnOnly is true when only the copy's old lines, not its write time, show that. `writtenAt` is the
 * file's mtime in ms, or null. `run` is a drift-land.mjs gitRunner. With `anyTime`, a copy that lacks a line landed
 * after its base counts whatever its write time and old lines say, for a writer that holds no deliberate revert.
 */
export function staleBase(run, head, p, own, tipCopy, writtenAt, { anyTime = false } = {}) {
  if (!own || !tipCopy || own === tipCopy) return null;
  const [mode, ownBlob] = own.split(' '), [, tipBlob] = tipCopy.split(' ');
  if (mode === '120000' || mode === '160000') return null;
  const first = readBlobs(run, [ownBlob, tipBlob]);
  if (!first.has(ownBlob) || !first.has(tipBlob)) return null;
  const mine = lineCounts(first.get(ownBlob)), tip = lineCounts(first.get(tipBlob));
  const lost = missing(tip, mine);
  if (!lost.size) return null;
  ensureChangedPaths(run);
  const log = run(['--literal-pathspecs', 'log', '--format=%x00%H %ct', '--raw', '--no-abbrev', '--no-renames', head, '--', p]);
  if (log.status !== 0) return null;
  // Newest first: every commit that changed p, with the blob it left.
  const history = [];
  for (const rec of log.stdout.split('\0').slice(1)) {
    const [top, ...rows] = rec.split('\n');
    const [commit, ct] = top.split(' ');
    const row = rows.find((l) => l.startsWith(':') && l.endsWith(`\t${p}`));
    const blob = row?.split('\t')[0].split(' ')[3];
    if (blob && !/^0+$/.test(blob)) history.push({ commit, at: Number(ct) * 1000, blob });
  }
  const blobs = [...new Set(history.map((v) => v.blob))];
  const texts = readBlobs(run, blobs.filter((b) => b !== tipBlob));
  texts.set(tipBlob, first.get(tipBlob));
  const counts = new Map([[tipBlob, tip]]);
  const countsOf = (b) => { if (!counts.has(b)) counts.set(b, lineCounts(texts.get(b))); return counts.get(b); };
  let best = null;
  for (const b of blobs) {
    if (!texts.has(b)) continue;
    const d = distance(mine, countsOf(b));
    if (best === null || d < best.d) best = { blob: b, d };
  }
  if (!best || best.blob === tipBlob) return null;
  const at = history.findIndex((v) => v.blob === best.blob);
  const base = countsOf(best.blob);
  const dropped = [...lost.keys()].filter((line) => !base.has(line) || base.get(line) < tip.get(line));
  if (!dropped.length) return null;
  if (anyTime) return { entry: `${mode} ${best.blob}`, tip: history[at].commit, inferred: true, warnOnly: false };
  // A line of the base that HEAD's version has none of, still in the copy.
  const keepsOld = [...base.keys()].some((line) => line.trim() && !tip.has(line) && mine.has(line));
  // The version of p when the file was written is the newest one committed by then, or the base when that is older.
  let lateLines = false;
  if (writtenAt !== null) {
    const then = history.findIndex((v) => v.at <= writtenAt);
    if (then !== 0) {
      const before = then > 0 && then < at ? countsOf(history[then].blob) : base;
      lateLines = dropped.some((line) => (before.get(line) ?? 0) < tip.get(line));
    }
  }
  if (!keepsOld && !lateLines) return null;
  return { entry: `${mode} ${best.blob}`, tip: history[at].commit, inferred: true, warnOnly: !lateLines };
}

/**
 * The older committed copy a full write of `content` to p was made from, when it drops lines that landed after that
 * copy: { entry, tip, since } with since the commits that changed p after it, newest first; null when the write reads
 * as an edit of HEAD's version or p is not in `head`. The page API refuses such a write, because the wiki host
 * commits a page the API wrote as meant (wiki-box-commit.mjs pageApiWrote), so it would undo those commits silently.
 */
export function staleWrite(run, head, p, content) {
  const ls = run(['--literal-pathspecs', 'ls-tree', '--full-tree', head, '--', p]);
  const [mode, type, tipBlob] = ls.status === 0 ? ls.stdout.split('\t')[0].split(' ') : [];
  if (type !== 'blob') return null;
  const own = run(['hash-object', '-w', '--stdin'], { input: content });
  if (own.status !== 0) throw new Error(`git hash-object: ${own.stderr.trim()}`);
  const base = staleBase(run, head, p, `${mode} ${own.stdout.trim()}`, `${mode} ${tipBlob}`, null, { anyTime: true });
  if (!base) return null;
  const log = run(['--literal-pathspecs', 'log', '--format=%h', `${base.tip}..${head}`, '--', p]);
  return { entry: base.entry, tip: base.tip, since: log.stdout.split('\n').filter(Boolean) };
}
