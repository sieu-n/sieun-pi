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
