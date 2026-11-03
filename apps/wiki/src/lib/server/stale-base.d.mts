/** A git runner: (args, { input, encoding }) => { status, stdout, stderr }. */
export type GitRun = (
	args: string[],
	opts?: { input?: string; encoding?: BufferEncoding | 'buffer' },
) => { status: number | null; stdout: any; stderr: string };

/** The older committed copy a full write of `content` to `p` was made from, when it drops lines that landed since; else null. */
export function staleWrite(run: GitRun, head: string, p: string, content: string): { entry: string; tip: string; since: string[] } | null;
