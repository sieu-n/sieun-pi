/**
 * Where an artifact link goes when the Markdown that drew it has no `onartifact` of its own. The shell's viewer registers itself here
 * (lib/shell/viewer.svelte.ts), so lib/ui needs no import of the router; with nothing registered a wiki link opens in a tab.
 */
type Opener = (target: string) => boolean;

let opener: Opener | null = null;

export function setArtifactOpener(next: Opener | null): void {
  opener = next;
}

/** Hand a target such as `wiki:<path>` or `thread:<id>` to the registered opener; false when none took it. */
export function openArtifact(target: string): boolean {
  return opener?.(target) ?? false;
}

/** A table or code block of a post, as markdown, for the viewer to show large. */
export type BlockContent = { kind: "table" | "code"; markdown: string; label: string };
type BlockOpener = (block: BlockContent) => void;

let blockOpener: BlockOpener | null = null;

export function setBlockOpener(next: BlockOpener | null): void {
  blockOpener = next;
}

/** Hand a block to the registered viewer; false when none is registered. */
export function openBlock(block: BlockContent): boolean {
  if (!blockOpener) return false;
  blockOpener(block);
  return true;
}
