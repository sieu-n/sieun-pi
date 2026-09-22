import { register } from "tsx/esm/api";

register();

try {
  const { runChatCommand } = await import("./chat-service.ts");
  await runChatCommand(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write("sieun-pi chat: " + message + "\n");
  if (process.connected) process.send?.({ error: message });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
