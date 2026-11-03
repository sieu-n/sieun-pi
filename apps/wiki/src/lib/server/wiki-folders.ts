import path from 'node:path';

/**
 * The direct children (pages and folders) of every content folder that holds a page at any depth, so a
 * folder event costs the pages under that folder, never a pass over every stored path (117k, at 8 ms a
 * pass). A folder whose pages are gone may stay with an empty set.
 */
export class FolderIndex {
	private readonly children = new Map<string, Set<string>>();

	has(folder: string): boolean {
		return this.children.has(folder);
	}

	/** Link a page into its folder, and each new folder into its parent, up to the first folder already known. */
	add(wikiPath: string): void {
		for (let child = wikiPath, folder = path.posix.dirname(child); folder !== '.'; ) {
			const children = this.children.get(folder);
			if (children) {
				children.add(child);
				return;
			}
			this.children.set(folder, new Set([child]));
			child = folder;
			folder = path.posix.dirname(folder);
		}
	}

	/** Unlink a page or folder from its parent. */
	remove(wikiPath: string): void {
		this.children.get(path.posix.dirname(wikiPath))?.delete(wikiPath);
	}

	/** Every stored page under `folder`. With `forget`, its folders leave the index. */
	pagesUnder(folder: string, forget = false, pages: string[] = []): string[] {
		for (const child of this.children.get(folder) ?? []) {
			if (this.children.has(child)) this.pagesUnder(child, forget, pages);
			else pages.push(child);
		}
		if (forget) this.children.delete(folder);
		return pages;
	}

	clear(): void {
		this.children.clear();
	}
}
