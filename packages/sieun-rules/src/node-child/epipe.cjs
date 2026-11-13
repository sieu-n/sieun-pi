"use strict";
/*
 * Preloaded into every Node process a Prime kernel starts (kernel-node.py puts it in NODE_OPTIONS). When the reader of stdout or stderr has
 * gone, as after `| head`, the process exits at once, as a C program does on SIGPIPE, which Node ignores. On the owner's Mac a CLI with a
 * Sentry uncaughtException handler, such as `npx convex data ... 2>&1 | head -c 3000`, instead looped on EPIPE errors of its own error logs
 * until V8's heap limit: 4.36 GB at 10:08Z on 11-08 and 4.41 GB for `vercel inspect ... 2>&1 | head -20` on 11-06. A program that listens for
 * the stream's errors itself keeps them: a detached Prime daemon worker ignores EPIPE on stderr so it outlives its supervisor, and on 11-13 this
 * file ended such workers in Prime's supervisor process tests the moment they logged after the supervisor died. Any other stream error reaches
 * the process as it would without this file.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", function exitWhenReaderLeft(error) {
    if (stream.listenerCount("error") > 1) return;
    if (error && error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}
