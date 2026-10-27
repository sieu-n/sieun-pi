import { register } from "tsx/esm/api";

register();
try {
  const { runDaemonCommand } = await import("./daemon-cli.ts");
  await runDaemonCommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`daemon-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
