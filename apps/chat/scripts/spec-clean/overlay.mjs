// The module hooks of scripts/spec-clean.mjs, which run a release folder's apps/chat with a few files' source taken from elsewhere.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The overlay a run carries in its environment: SPEC_CLEAN_RELEASE is the release's apps/chat folder and SPEC_CLEAN_OVERLAY maps each path
 * relative to it to the file whose source replaces it. Null outside a spec-clean run.
 */
export function overlayFromEnv(env = process.env) {
  if (!env.SPEC_CLEAN_RELEASE) return null;
  return { release: env.SPEC_CLEAN_RELEASE, files: new Map(Object.entries(JSON.parse(env.SPEC_CLEAN_OVERLAY ?? "{}"))) };
}

const pathOf = url => (url?.startsWith("file:") ? fileURLToPath(url) : null);
const urlOf = path => pathToFileURL(path).href;

/**
 * Node module hooks (module.registerHooks) for an overlay.
 * In "source" mode a swapped file keeps its release URL and only its source changes, so its imports, bare packages and import.meta.url all
 * resolve in the release folder; tsx and Node read source through the load chain, so the server and node --test runs use this mode.
 * In "redirect" mode a swapped file resolves to its source file's URL, because Playwright's own load hook reads a test file from disk and never
 * asks the chain for its source. In both modes every import from a source file loaded by its own path, such as a test file only the overlay has,
 * resolves as if the file sat at its release path, so it loads the release's helpers and the release's @playwright/test.
 */
export function overlayHooks({ release, files }, mode) {
  const sourceOf = new Map([...files].map(([path, source]) => [join(release, path), source]));
  const targetOf = new Map([...sourceOf].map(([target, source]) => [source, target]));
  const isSwapped = path => sourceOf.has(path);

  /** The swapped release path a relative specifier names, for a file the overlay adds that the release folder lacks. */
  function added(specifier, parentPath) {
    const base = specifier.startsWith("file:") ? fileURLToPath(specifier)
      : specifier.startsWith("/") ? specifier
      : specifier.startsWith(".") && parentPath ? resolve(dirname(parentPath), specifier)
      : null;
    if (!base) return null;
    return [base, base.replace(/\.js$/, ".ts"), `${base}.ts`].find(isSwapped) ?? null;
  }

  /** Resolves through `next`, and falls back to a swapped file the release lacks. */
  function resolveAdded(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      const target = error?.code === "ERR_MODULE_NOT_FOUND" ? added(specifier, pathOf(context.parentURL)) : null;
      if (!target) throw error;
      return { url: urlOf(target), format: target.endsWith(".ts") ? "module-typescript" : "module", shortCircuit: true };
    }
  }

  function resolveHook(specifier, context, next) {
    const parent = pathOf(context.parentURL);
    const parentTarget = parent ? targetOf.get(parent) : undefined;
    const result = resolveAdded(specifier, parentTarget ? { ...context, parentURL: urlOf(parentTarget) } : context, next);
    let path = pathOf(result.url);
    // Playwright's resolve hook runs first and turns a relative specifier into a path beside the source file; move it beside the release path.
    if (path && parentTarget && !targetOf.has(path) && !path.includes(`${sep}node_modules${sep}`)) {
      const rebased = resolve(dirname(parentTarget), relative(dirname(parent), path));
      if (existsSync(rebased) || isSwapped(rebased)) path = rebased;
    }
    const source = mode === "redirect" && path ? sourceOf.get(path) : undefined;
    if (source) return { ...result, url: urlOf(source), shortCircuit: true };
    return path && path !== pathOf(result.url) ? { ...result, url: urlOf(path), shortCircuit: true } : result;
  }

  function load(url, context, next) {
    const path = pathOf(url);
    const source = path && mode === "source" ? sourceOf.get(path) : undefined;
    if (!source) return next(url, context);
    const text = readFileSync(source, "utf8");
    if (existsSync(path)) return { ...next(url, context), source: text };
    return { format: context.format ?? (path.endsWith(".ts") ? "module-typescript" : "module"), source: text, shortCircuit: true };
  }

  return { resolve: resolveHook, load };
}
