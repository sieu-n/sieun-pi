// Imported before the scripts under test, so wiki-config.mjs, which caches its first read, never reads the box's
// ~/.config/sieun-pi/wiki.json. With that file, page-gate.mjs pagesAt reads the live content root instead of the fixture repo's
// pages at <rev>, and on 2026-11-16 two page-gate tests failed on us-metal02 that way.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.WIKI_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-wiki-config.json');
