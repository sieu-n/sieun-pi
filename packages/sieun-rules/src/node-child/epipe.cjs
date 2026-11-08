"use strict";
/*
 * Preloaded into every Node process a Prime kernel starts (kernel-node.py puts it in NODE_OPTIONS). When the reader of stdout or stderr has
 * gone, as after `| head`, the process exits at once, as a C program does on SIGPIPE, which Node ignores. On the owner's Mac a CLI with a
 * Sentry uncaughtException handler, such as `npx convex data ... 2>&1 | head -c 3000`, instead looped on EPIPE errors of its own error logs
 * until V8's heap limit: 4.36 GB at 10:08Z on 11-08 and 4.41 GB for `vercel inspect ... 2>&1 | head -20` on 11-06. Any other stream error
 * reaches the process as it would without this file.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", function exitWhenReaderLeft(error) {
    if (error && error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    if (stream.listenerCount("error") === 1) throw error;
  });
}
