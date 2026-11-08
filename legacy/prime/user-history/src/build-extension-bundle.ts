import { readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_INPUTS, bundleName, type BundleInputs, COMPONENT, freshBundle, inputsDigest } from "./extension-bundle.ts";

const LOADERS: Record<string, "ts" | "js" | "json"> = { ".ts": "ts", ".js": "js", ".mjs": "js", ".json": "json" };
const BUILT = /^extension\.[0-9a-f]{16}\.bundle\.mjs$/;

export type BuiltBundle = { name: string; text: string; inputs: string[]; imports: { path: string; kind: string }[] };

function writeAtomic(path: string, data: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

/**
 * Bundles extension/index.ts with esbuild into src/ under a name that carries its digest, then writes BUNDLE_INPUTS, so a reader that sees
 * the new record finds the new bundle. It keeps the bundle the old record named, for a worker that read that record a moment ago, and deletes
 * older ones. Packages stay imports, and chat-service.ts stays a dynamic import of the source file. `write: false` touches nothing.
 */
export async function buildExtensionBundle(dir: string = COMPONENT, write = true): Promise<BuiltBundle> {
  const { build } = await import("esbuild");
  const read = new Map<string, Buffer>();
  const result = await build({
    entryPoints: [join(dir, "extension/index.ts")], outfile: join(dir, "src/extension.bundle.mjs"), absWorkingDir: dir, bundle: true, write: false,
    metafile: true, platform: "node", format: "esm", target: "node22", packages: "external", external: ["../src/chat-service.ts"], logLevel: "warning",
    plugins: [{
      name: "record-inputs",
      setup(bundler) {
        bundler.onLoad({ filter: /.*/ }, args => {
          const loader = LOADERS[extname(args.path)];
          if (!loader) return undefined;
          const bytes = readFileSync(args.path);
          read.set(relative(dir, args.path), bytes);
          return { contents: bytes, loader };
        });
      },
    }],
  });
  const output = result.outputFiles[0];
  const meta = Object.values(result.metafile.outputs)[0];
  if (!output || !meta) throw new Error("esbuild wrote no bundle");
  const missing = Object.keys(result.metafile.inputs).filter(name => !read.has(name));
  if (missing.length) throw new Error(`bundle inputs with no recorded bytes: ${missing.join(", ")}`);
  const inputs = [...read.keys()].sort();
  const digest = inputsDigest(inputs, name => read.get(name)!);
  const name = bundleName(digest);
  if (write) {
    let previous: string | undefined;
    try { previous = bundleName((JSON.parse(readFileSync(join(dir, BUNDLE_INPUTS), "utf8")) as BundleInputs).digest); } catch { previous = undefined; }
    writeAtomic(join(dir, name), output.text);
    writeAtomic(join(dir, BUNDLE_INPUTS), JSON.stringify({ inputs, digest } satisfies BundleInputs) + "\n");
    const keep = new Set([basename(name), previous && basename(previous)]);
    for (const file of readdirSync(join(dir, "src"))) if (BUILT.test(file) && !keep.has(file)) rmSync(join(dir, "src", file), { force: true });
  }
  return { name, text: output.text, inputs, imports: meta.imports.map(({ path, kind }) => ({ path, kind })) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    console.log("usage: node src/build-extension-bundle.ts [--if-stale]\nBuilds the user-history extension bundle in src/; --if-stale prints \"fresh\" and builds nothing when the bundle matches the source.");
  } else if (process.argv.includes("--if-stale") && freshBundle()) {
    console.log("fresh");
  } else {
    const { name, inputs } = await buildExtensionBundle();
    console.log(`built ${name} from ${inputs.length} inputs`);
  }
}
