import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one-file build of the user-history extension and the record of what it was built from. Prime runs every .ts module of an extension
 * through jiti and Babel: on us-metal02 on 11-08 the 73 source files cost 0.42 CPU-s of each worker start on a warm jiti cache and 7.7 CPU-s
 * on a cold one, which a reboot or an edit of a file makes, while the bundle cost 0.25 CPU-s either way (p1485). The bundle sits in src/, so
 * the paths its modules resolve from their own folder (load-wait-end.py, message-limit-check.py, the dynamic import of chat-service.ts) still
 * name the same files. Its name carries its digest, because Bun keeps a natively imported module for the life of the process and jiti drops
 * a query string, so a reload in a worker after a new build must import a new path to run the new code.
 */
export const COMPONENT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLE_INPUTS = "src/extension.bundle.json";
export const bundleName = (digest: string): string => `src/extension.${digest.slice(0, 16)}.bundle.mjs`;

/** BUNDLE_INPUTS: the files esbuild read, relative to the component folder, and a digest of their names and bytes. */
export type BundleInputs = { inputs: string[]; digest: string };

export function inputsDigest(inputs: readonly string[], read: (name: string) => Uint8Array): string {
  const hash = createHash("sha256");
  for (const name of inputs) hash.update(name).update("\0").update(read(name)).update("\0");
  return hash.digest("hex");
}

/** The bundle in `dir` when it was built from the bytes its inputs hold now, else undefined, so a live edit loads from source until the next build. */
export function freshBundle(dir: string = COMPONENT): string | undefined {
  try {
    const { inputs, digest } = JSON.parse(readFileSync(join(dir, BUNDLE_INPUTS), "utf8")) as BundleInputs;
    const bundle = join(dir, bundleName(digest));
    return statSync(bundle).isFile() && inputsDigest(inputs, name => readFileSync(join(dir, name))) === digest ? bundle : undefined;
  } catch {
    return undefined;
  }
}
