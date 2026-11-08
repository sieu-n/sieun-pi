// The wiki backup keeps the scripts in the curated spaces beside the pages, because a page generator lives only there.
// Run: node --test --test-force-exit --test-isolation=none tests/wiki-backup-files.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { wikiPages } from '../scripts/wiki-storage/lib.mjs';

test('the backup takes pages everywhere and scripts only in the curated spaces (2026-11-08, api-endpoints generator)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-backup-files-'));
  try {
    const files = [
      'index.html',
      'apps/api-portal/platform/api-endpoints.html',
      'apps/api-portal/platform/api-endpoints-facts.mjs',
      'domains/x/scripts/run.py',
      'sessions/2026/11/08/1200-x/data/dump.mjs',
      'apps/x/node_modules/dep/index.js',
      'apps/x/data/rows.csv',
    ];
    for (const f of files) {
      mkdirSync(path.dirname(path.join(root, 'content', f)), { recursive: true });
      writeFileSync(path.join(root, 'content', f), 'x');
    }
    const pages = wikiPages({ contentRoot: path.join(root, 'content'), agentsRoot: path.join(root, 'agents') });
    assert.deepEqual([...pages.keys()].sort(), [
      'apps/api-portal/platform/api-endpoints-facts.mjs',
      'apps/api-portal/platform/api-endpoints.html',
      'domains/x/scripts/run.py',
      'index.html',
    ]);
    assert.equal(pages.get('domains/x/scripts/run.py').abs, path.join(root, 'content', 'domains/x/scripts/run.py'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
