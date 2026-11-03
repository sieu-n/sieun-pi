import { text } from '@sveltejs/kit';
import { getLlmsText } from '$lib/server/wiki';

export async function GET() {
	return text(await getLlmsText(true), {
		headers: {
			'cache-control': 'no-store',
		},
	});
}
