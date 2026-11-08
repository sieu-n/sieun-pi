import type { ExtensionAPI } from "prime-agent";
import { freshBundle } from "../src/extension-bundle.ts";

/**
 * Prime's entry for the user-history extension. It loads the bundle in src/ when that bundle was built from the source on disk now, and
 * extension/index.ts otherwise, so an edit is live in the next worker either way. prime-sync rebuilds the bundle on a box that loads the
 * extension from its checkout, and scripts/install-runtime.mjs builds it into each runtime release.
 */
export default async function userHistory(pi: ExtensionAPI): Promise<void> {
  const bundle = freshBundle();
  const { default: extension } = (bundle ? await import(bundle) : await import("./index.ts")) as { default: (pi: ExtensionAPI) => void };
  extension(pi);
}
