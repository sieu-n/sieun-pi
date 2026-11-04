import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { REPO } from "./estate-reads.ts";

/**
 * Where each tier's Convex backend is named: the client URL row of an auto-sns-agent tier file, the row the prod cutover to the
 * self-hosted backend on us-metal01 changes (11-04, prod-convex-flip.patch), and the ci file that holds the admin keys. The URL row is read
 * at `ref`, the branch the tier deploys from, because the checkout's dev branch moves ahead of it: on 11-04 at 20:42Z 30a60cdf2e flipped
 * the row on dev/sieun to convex.virev.ai, which served 0 functions, while prod still ran befitting-sparrow-356 from main, so the
 * watchlist-green precheck got "Could not find public function" and measured no owner key.
 */
export const CONVEX_ROWS = {
  production: { file: "apps/api-portal/.env", name: "VITE_CONVEX_URL", ref: "origin/main", keys: "apps/ci/.env" },
  staging: { file: "apps/api-portal/.env.staging", name: "VITE_CONVEX_URL", ref: "origin/staging", keys: "apps/ci/.env.staging" },
} as const;
export type ConvexTier = keyof typeof CONVEX_ROWS;
/** A Convex backend's client URL, its instance name and an admin key of it. */
export interface ConvexBackend { url: string; instance: string; adminKey: string }
/** One dotenvx row of a repo file, or every row as JSON when no name is given; with a ref, of the file as that git ref holds it. */
export type EnvRead = (file: string, name?: string, ref?: string) => Promise<string>;

const run = promisify(execFile);

export const readEnvRow: EnvRead = async (file, name, ref) => {
  const dotenvx = (path: string, keys: string[]) =>
    run(join(REPO, "node_modules/.bin/dotenvx"), ["get", ...name ? [name] : [], "-f", path, ...keys], { cwd: REPO, encoding: "utf8" });
  if (!ref) return (await dotenvx(join(REPO, file), [])).stdout.trim();
  const blob = (await run("git", ["-C", REPO, "show", `${ref}:${file}`], { encoding: "utf8" })).stdout;
  const dir = await mkdtemp(join(tmpdir(), "convex-row-"));
  try {
    const path = join(dir, basename(file));
    await writeFile(path, blob);
    return (await dotenvx(path, ["-fk", join(REPO, dirname(file), ".env.keys")])).stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * The backend a tier's URL row names, with its admin key. Cloud and self-hosted backends both answer GET /instance_name, and the key is the
 * ci file's value for that instance: a cloud deploy key reads `prod:<instance>|`, a self-hosted admin key `<instance>|`.
 */
export async function convexBackend(tier: ConvexTier, fetcher: typeof fetch = fetch, read: EnvRead = readEnvRow, signal?: AbortSignal): Promise<ConvexBackend> {
  const row = CONVEX_ROWS[tier];
  const url = (await read(row.file, row.name, row.ref)).replace(/\/+$/, "");
  if (!url.startsWith("https://")) throw new Error(`${row.name} of ${row.file} did not decrypt to a URL`);
  const answer = await fetcher(`${url}/instance_name`, signal ? { signal } : {});
  const instance = (await answer.text()).trim();
  if (!answer.ok || !/^[a-z0-9-]+$/.test(instance)) throw new Error(`${url}/instance_name gave HTTP ${answer.status}`);
  const adminKey = Object.values(JSON.parse(await read(row.keys)) as Record<string, string>)
    .find(value => value.replace(/^[a-z]+:/, "").startsWith(`${instance}|`));
  if (!adminKey) throw new Error(`${row.keys} holds no admin key of ${instance}`);
  return { url, instance, adminKey };
}

/** A query on the backend as admin, the /api/query call `convex run` makes. */
export const adminQuery = (backend: ConvexBackend, fetcher: typeof fetch = fetch, signal?: AbortSignal) =>
  async <T>(path: string, args: unknown): Promise<T> => {
    const response = await fetcher(`${backend.url}/api/query`, { method: "POST", ...signal ? { signal } : {},
      headers: { authorization: `Convex ${backend.adminKey}`, "content-type": "application/json", "convex-client": "npm-cli-1.34.0" },
      body: JSON.stringify({ path, args, format: "json" }) });
    const body = await response.json().catch(() => null) as { status?: string; errorMessage?: string; value?: T } | null;
    if (body?.status !== "success" || body.value === undefined) {
      throw new Error(`${backend.instance} ${path}: HTTP ${response.status} ${String(body?.errorMessage ?? "no value").slice(0, 200)}`);
    }
    return body.value;
  };
