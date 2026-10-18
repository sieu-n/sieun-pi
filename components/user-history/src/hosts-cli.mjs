import { register } from "tsx/esm/api";

register();
try {
  const { runHostsCommand } = await import("./hosts-cli.ts");
  await runHostsCommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`sieun-pi hosts: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
