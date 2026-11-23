import type { LoadHookSync, ResolveHookSync } from "node:module";

export interface Overlay {
  /** The release's apps/chat folder. */
  release: string;
  /** Path relative to `release` -> the file whose source replaces it. */
  files: Map<string, string>;
}

export function overlayFromEnv(env?: NodeJS.ProcessEnv): Overlay | null;
export function overlayHooks(overlay: Overlay, mode: "source" | "redirect"): { resolve: ResolveHookSync; load: LoadHookSync };
