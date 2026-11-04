// Types for mermaidWriteCheck, for the same reason as dup-held.d.mts.

/** Each mermaid block of a page outside a comment, in page order, with its inner HTML. */
export function mermaidBlocks(html: string): { line: number; raw: string }[];

/** The parse error of each raw block, or null when it parses. */
export function parseMermaid(raws: string[]): Promise<(string | null)[]>;

/** Why one page write is refused (a broken block it adds) and its warnings (a broken block the page already held). */
export function mermaidWriteCheck(before: string | null, after: string): Promise<{ reasons: string[]; warnings: string[] }>;
