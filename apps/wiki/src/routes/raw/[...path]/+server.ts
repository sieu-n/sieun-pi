import { error } from '@sveltejs/kit';
import path from 'node:path';
import { getContentRoot, normalizeRequestedPath } from '$lib/server/wiki';
import { readWikiFile } from '$lib/server/wiki-mirror';

const CONTENT_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.svg': 'image/svg+xml',
	'.pdf': 'application/pdf',
};

export async function GET({ params }) {
	let relativePath: string;
	try {
		relativePath = normalizeRequestedPath(params.path);
	} catch {
		error(400, 'Invalid path');
	}

	let data: Buffer;
	try {
		data = (await readWikiFile({ wikiPath: relativePath, contentRoot: getContentRoot() })).bytes;
	} catch {
		error(404, 'Asset not found');
	}
	const type = CONTENT_TYPES[path.extname(relativePath).toLowerCase()] ?? 'application/octet-stream';
	return new Response(new Uint8Array(data), {
		headers: { 'content-type': type, 'cache-control': 'public, max-age=300' },
	});
}
