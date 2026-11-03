import type { RequestEvent } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { extname } from 'node:path';
import { artifactPath } from '$lib/specs/specs.mjs';

const TYPES: Record<string, string> = {
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
};

/** Serves one file from content/.wiki/spec-results. HTML is sent as text so a captured page never runs here. */
export function GET(event: RequestEvent) {
	const rel = event.url.searchParams.get('path') ?? '';
	if (!rel || rel.includes('\0')) error(400, 'path is required.');
	let file: string;
	try {
		file = artifactPath(rel);
	} catch {
		error(400, 'path must be inside the result store.');
	}
	if (!existsSync(file) || !statSync(file).isFile()) error(404, 'No such artifact.');
	const type = TYPES[extname(file).toLowerCase()] ?? 'text/plain; charset=utf-8';
	return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
		headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
	});
}
