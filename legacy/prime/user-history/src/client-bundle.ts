import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `br` and `gzip` are the body compressed at the best level ahead of time (`packAsset`); an asset without them is gzipped on its first request. */
export interface Asset { body: Buffer; etag: string; contentType: string; br?: Buffer; gzip?: Buffer }
/**
 * The page's script and style, and `version`, which names this build: the page carries it and the sessions stream reports it. `preload` names
 * the chunks app.js imports at once (`chunk.<hash>.js`), which the shell asks for beside app.js.
 */
export interface PackedBundle { js: Asset; css: Asset; version: string; preload?: string[] }

export function asset(body: Uint8Array, contentType: string): Asset {
  const buffer = Buffer.from(body);
  return { body: buffer, etag: '"' + createHash("sha256").update(buffer).digest("hex").slice(0, 32) + '"', contentType };
}

/**
 * The name the page asks for an asset by: its content hash is in the name, so the browser keeps it with `immutable` and a later load reads
 * it from disk with no request. On 10-18 app.js and app.css went out as `no-cache`, and every load from Korea paid a round trip to revalidate
 * them before the script could start.
 */
export function assetName(stem: string, extension: string, asset: Asset): string {
  return `${stem}.${asset.etag.replace(/"/g, "").slice(0, 16)}.${extension}`;
}

export const packedBundle = (js: Asset, css: Asset, preload: string[] = []): PackedBundle => ({ js, css, version: createHash("sha256").update(js.etag + css.etag).digest("hex").slice(0, 16),
  ...(preload.length ? { preload } : {}) });

/**
 * The chunks of a split app.js (chat-assets.ts `compileClient`) in a packed bundle folder: `chunks.json` names them and the ones app.js imports
 * at once, and each sits beside app.js with its `.br` and `.gz`. A folder without `chunks.json` holds an app.js with no chunks.
 */
const CHUNKS_FILE = "chunks.json";
export interface ChunkList { names: string[]; preload: string[] }
export const chunkPattern = /^chunk\.[A-Z0-9]{4,16}\.js$/;

export async function writeChunks(dir: string, chunks: Record<string, Asset>, preload: readonly string[]): Promise<void> {
  for (const [name, packed] of Object.entries(chunks)) {
    const [body, br, gzip] = prebuiltFiles(name);
    await writeFile(join(dir, body!), packed.body);
    await writeFile(join(dir, br!), packed.br!);
    await writeFile(join(dir, gzip!), packed.gzip!);
  }
  await writeFile(join(dir, CHUNKS_FILE), JSON.stringify({ names: Object.keys(chunks), preload: [...preload] } satisfies ChunkList) + "\n");
}

export async function readChunkList(dir: string): Promise<ChunkList> {
  const text = await readFile(join(dir, CHUNKS_FILE), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (text === null) return { names: [], preload: [] };
  const value = JSON.parse(text) as Partial<ChunkList>;
  const names = (value.names ?? []).filter(name => chunkPattern.test(name));
  return { names, preload: (value.preload ?? []).filter(name => names.includes(name)) };
}

export async function readChunks(dir: string, names: readonly string[]): Promise<Record<string, Asset>> {
  const read = async (name: string): Promise<[string, Asset]> => {
    const [body, br, gzip] = await Promise.all(prebuiltFiles(name).map(file => readFile(join(dir, file))));
    return [name, { ...asset(body!, "text/javascript; charset=utf-8"), br: br!, gzip: gzip! }];
  };
  return Object.fromEntries(await Promise.all(names.map(read)));
}

/**
 * The packed bundle release-chat.mjs writes into a release before it goes live (`chat-assets-prebuild.mjs`), so a restart reads it from disk.
 * A checkout without it compiles at start. On 10-18 the compile took 6.5 s at a load of 50, and every page shell waited for it after each of
 * the day's 21 restarts by 08:40Z.
 */
export const PREBUILT_DIR = fileURLToPath(new URL("../.client-bundle/", import.meta.url));
const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const prebuiltFiles = (stem: string) => [stem, `${stem}.br`, `${stem}.gz`];

/** Writes a packed bundle into `dir`, through a draft folder renamed into place, so a folder that exists is whole. */
export async function writePacked(dir: string, js: Asset, css: Asset): Promise<void> {
  const draft = `${dir.replace(/\/+$/, "")}.${process.pid}.tmp`;
  await rm(draft, { recursive: true, force: true });
  await mkdir(draft, { recursive: true });
  for (const [stem, packed] of [["app.js", js], ["app.css", css]] as const) {
    const [body, br, gzip] = prebuiltFiles(stem);
    await writeFile(join(draft, body!), packed.body);
    await writeFile(join(draft, br!), packed.br!);
    await writeFile(join(draft, gzip!), packed.gzip!);
  }
  await rm(dir, { recursive: true, force: true });
  await rename(draft, dir);
}

/** The packed bundle in `dir`, or null when the folder or one of its files is missing. */
export async function readPacked(dir: string): Promise<PackedBundle | null> {
  const read = async (stem: string, contentType: string): Promise<Asset> => {
    const [body, br, gzip] = await Promise.all(prebuiltFiles(stem).map(name => readFile(join(dir, name))));
    return { ...asset(body!, contentType), br: br!, gzip: gzip! };
  };
  try {
    const [js, css, chunks] = await Promise.all([read("app.js", "text/javascript; charset=utf-8"), read("app.css", "text/css; charset=utf-8"), readChunkList(dir)]);
    return packedBundle(js, css, chunks.preload);
  } catch { return null; }
}

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * A hash of everything the client bundle is built from: src/client, src/shared, the build code and the lockfile. Releases on 10-18 were built by a helper that
 * wrote no prebuilt bundle, and each of the day's restarts compiled the same client again (12.1 s to the first page at 12:42Z); a release that
 * changes no client file now reads the bundle a former start wrote to the cache under this hash.
 */
export async function clientSourceHash(appDir = APP_DIR): Promise<string> {
  const hash = createHash("sha256");
  const paths = [...await files(join(appDir, "src/client")), ...await files(join(appDir, "src/shared")),
    ...["package-lock.json", "src/chat-assets.ts", "src/prepaint.ts"].map(name => join(appDir, name))].sort();
  for (const path of paths) hash.update(path.slice(appDir.length)).update("\0").update(await readFile(path).catch(() => "")).update("\0");
  return hash.digest("hex").slice(0, 32);
}

export const bundleCacheDir = (hash: string, home = homedir()): string => join(home, ".cache", "sieun-pi", "client-bundle", hash);

/** The release's prebuilt bundle, else the cache's for the same client sources; null when neither has one. */
export async function readBuiltBundle(dir = PREBUILT_DIR, appDir = APP_DIR): Promise<{ bundle: PackedBundle | null; cache: string }> {
  const cache = bundleCacheDir(await clientSourceHash(appDir));
  return { bundle: await readPacked(dir) ?? await readPacked(cache), cache };
}
