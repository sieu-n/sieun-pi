/**
 * The release folder's own playwright.config.ts, pointed at that folder: its test/ specs, its fixture server with the overlay loaded, and the
 * web build scripts/spec-clean.mjs picked (the release's web/dist, or a build with the overlay's web/ files in the run's folder).
 * Only scripts/spec-clean.mjs runs it, with the release's playwright and the env it sets.
 */
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is unset; run the specs with node apps/chat/scripts/spec-clean.mjs -- playwright test ...`);
  return value;
};
const release = env("SPEC_CLEAN_RELEASE");
const webDir = env("SPEC_CLEAN_WEB_DIR");
const runDir = env("SPEC_CLEAN_RUN_DIR");
const serverUrl = env("CHAT_SERVER_URL");
const devPort = env("CHAT_WEB_PORT");
const vite = join(import.meta.dirname, "vite.mjs");

const added: string[] = JSON.parse(process.env.SPEC_CLEAN_ADDED_SPECS ?? "[]");

const { default: base } = await import(pathToFileURL(join(release, "playwright.config.ts")).href);
const [server, dev] = Array.isArray(base.webServer) ? base.webServer : [base.webServer];
/** Specs only the overlay has, which the release's test/ lacks: one project per folder that holds them, on the "chrome" project's settings. */
const chrome = base.projects.find((project: { name: string }) => project.name === "chrome");
const addedProjects = [...new Set(added.map(file => dirname(file)))].map((folder, n) => ({
  name: `chrome-added${n ? `-${n + 1}` : ""}`,
  use: chrome.use,
  testDir: folder,
  testMatch: added.filter(file => dirname(file) === folder).map(file => new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)),
}));

export default {
  ...base,
  testDir: join(release, "test"),
  globalSetup: join(release, "test/global-setup.ts"),
  projects: [...base.projects, ...addedProjects],
  webServer: [
    {
      ...server,
      command: `SPEC_CLEAN_MODE=source exec node --import tsx server/main.ts --fixture --port ${new URL(serverUrl).port} --web-dir ${webDir}`,
      cwd: release,
      reuseExistingServer: false,
    },
    {
      ...dev,
      command: `SPEC_CLEAN_MODE=source exec node ${vite} serve ${devPort} ${join(runDir, "vite-cache")}`,
      cwd: join(release, "web"),
      reuseExistingServer: false,
    },
  ],
};
