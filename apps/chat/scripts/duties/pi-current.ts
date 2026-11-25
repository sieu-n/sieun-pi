/**
 * Duty precheck: pi-host runs the newest upstream Pi, and its vendored Prime harness matches the Prime release the daemon runs (owner,
 * #sw-factory-build p245, 11-26, msg mwwkxdqq, answering "I'd add a weekly duty that tries the newest Pi on a test host and bumps the pin when
 * our tests pass. Sound right?": "yeah weekly duty sound good.").
 *
 * It reads each @earendil-works/* dependency that packages/pi-host/package.json pins on origin/main, asks npm for the package's latest and its
 * published versions (`npm view <pkg> version versions --json`), and counts the stable releases after the pin up to latest: on 11-26 every
 * package was pinned at 1.4.0 with 1.5.0, 1.5.1, 1.5.2, 1.6.0 and 1.6.1 published, 5 releases behind. The headline is the count of the package
 * furthest behind, since the five packages publish together.
 *
 * Vendored Prime is behind when `node scripts/vendor-prime-harness.mjs --check` exits non-zero in the checkout: that script, which
 * packages/pi-host test/durable/prime-harness.test.ts also runs, compares vendor/prime-harness.ts and its fixture with what the commit of the
 * daemon's Prime release gives.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/pi-current.ts [--repo /home/sieun/src/sieun-pi]
 * Without OUTPUT_FILE the result prints to stdout.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const SCOPE = "@earendil-works/";
const PACKAGE_JSON = "packages/pi-host/package.json";

export interface PiPackage { name: string; pinned: string; latest: string; versions: string[] }
export interface PrimeCheck { behind: boolean; line: string }
export interface Flag { kind: string; sig: string; excerpt: string }

/** The pinned version of each @earendil-works/* dependency in a package.json, with a leading ^, ~ or = dropped. */
export function pins(packageJson: string): Record<string, string> {
  const json = JSON.parse(packageJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const all = { ...json.devDependencies, ...json.dependencies };
  return Object.fromEntries(Object.entries(all).filter(([name]) => name.startsWith(SCOPE)).map(([name, range]) => [name, range.replace(/^[\^~=]/, "")]));
}

const parts = (version: string): number[] => version.split(".").map(Number);
function compare(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The stable versions published after `pinned`, up to and with `latest`, oldest first. A prerelease such as 1.6.0-rc.1 is left out. */
export function newer(pkg: PiPackage): string[] {
  return pkg.versions.filter(v => /^\d+\.\d+\.\d+$/.test(v) && compare(v, pkg.pinned) > 0 && compare(v, pkg.latest) <= 0).sort(compare);
}

/** The precheck output for the pinned packages and the vendored Prime check. */
export function piCurrent(packages: readonly PiPackage[], prime: PrimeCheck): { metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  let most = 0;
  let behind = 0;
  for (const pkg of packages) {
    const releases = newer(pkg);
    if (!releases.length) continue;
    behind += 1;
    most = Math.max(most, releases.length);
    flagged.push({
      kind: "pi_behind", sig: `${pkg.name}@${pkg.latest}`,
      excerpt: `${pkg.name} is pinned at ${pkg.pinned} in ${PACKAGE_JSON}, ${releases.length} release${releases.length === 1 ? "" : "s"} behind npm latest ${pkg.latest} (${releases.join(", ")})`,
    });
  }
  if (prime.behind) {
    const sha = /[0-9a-f]{40}/.exec(prime.line)?.[0] ?? "unknown";
    flagged.push({ kind: "prime_vendor_behind", sig: `prime@${sha}`, excerpt: `vendored Prime is behind the daemon's Prime release: ${prime.line}` });
  }
  return {
    metrics: { pi_releases_behind: most, packages_behind: behind, prime_vendor_behind: prime.behind ? 1 : 0, packages_checked: packages.length },
    flagged,
  };
}

/** The package's latest version and every version npm has published. */
function npmView(name: string): { latest: string; versions: string[] } {
  const out = JSON.parse(execFileSync("npm", ["view", name, "version", "versions", "--json"], { encoding: "utf8" })) as { version: string; versions: string[] | string };
  return { latest: out.version, versions: Array.isArray(out.versions) ? out.versions : [out.versions] };
}

/** `scripts/vendor-prime-harness.mjs --check` in the checkout: behind when it exits non-zero, with the line it printed. */
function primeCheck(repo: string): PrimeCheck {
  const run = spawnSync("node", [join(repo, "scripts/vendor-prime-harness.mjs"), "--check"], { cwd: repo, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  const line = `${run.stderr ?? ""}${run.stdout ?? ""}`.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${run.status}`;
  return { behind: run.status !== 0, line };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { repo: { type: "string" } } });
  const repo = values.repo ?? process.env.SIEUN_PI_REPO ?? join(process.env.HOME ?? "", "src/sieun-pi");
  // prime-sync fetches origin/main in the checkout each minute.
  const pinned = pins(execFileSync("git", ["-C", repo, "show", `origin/main:${PACKAGE_JSON}`], { encoding: "utf8" }));
  const packages = Object.entries(pinned).map(([name, version]) => ({ name, pinned: version, ...npmView(name) }));
  const json = JSON.stringify(piCurrent(packages, primeCheck(repo)), null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else console.log(json);
}
