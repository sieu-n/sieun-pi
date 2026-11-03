import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { siblingRepos } from '../src/lib/sibling-repos.mjs';

// On 2026-10-28 the Mac kept sieun-pi at ~/Documents/Github/sieun-pi and no ~/src/sieun-pi, so the page gate read every
// sieun-pi path a staging page cited as missing and land-object.mjs refused the take-in b8e8c5fbc5 until SIEUN_PI_REPO
// was set by hand.
function home(t, ...checkouts) {
	const dir = mkdtempSync(path.join(tmpdir(), 'sibling-repos-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const rel of checkouts) mkdirSync(path.join(dir, rel, '.git'), { recursive: true });
	return dir;
}

test('finds sieun-pi under ~/Documents/Github when ~/src has none', (t) => {
	const dir = home(t, 'Documents/Github/sieun-pi');
	assert.equal(siblingRepos({}, dir).get('sieun-pi'), path.join(dir, 'Documents/Github/sieun-pi'));
});

test('prefers SIEUN_PI_REPO, then ~/src/sieun-pi', (t) => {
	const dir = home(t, 'src/sieun-pi', 'Documents/Github/sieun-pi', 'elsewhere');
	assert.equal(siblingRepos({}, dir).get('sieun-pi'), path.join(dir, 'src/sieun-pi'));
	assert.equal(siblingRepos({ SIEUN_PI_REPO: path.join(dir, 'elsewhere') }, dir).get('sieun-pi'), path.join(dir, 'elsewhere'));
});

test('leaves sieun-pi out when no root holds a checkout', (t) => {
	assert.equal(siblingRepos({ SIEUN_PI_REPO: path.join(home(t), 'missing') }, home(t)).has('sieun-pi'), false);
});
