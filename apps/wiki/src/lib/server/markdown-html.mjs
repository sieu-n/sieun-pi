import { marked } from 'marked';

/**
 * Convert a markdown page body to HTML. marked turns a ```mermaid fence into
 * `<pre><code class="language-mermaid">`, and the page script draws only `pre.mermaid`.
 * @param {string} body
 * @returns {Promise<string>}
 */
export async function markdownToHtml(body) {
	const html = await marked.parse(body, { gfm: true, async: true });
	return html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, '<pre class="mermaid">$1</pre>');
}
