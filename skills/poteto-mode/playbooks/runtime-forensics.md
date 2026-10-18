### Runtime forensics

For a live process that leaks, spins, glitches, or slows down. The output is a cited diagnosis, not a fix.

1. Capture the live signal on the real surface, such as a CPU profile for a spin, a heap snapshot for a leak, or a performance trace from the Aside REPL for a visual glitch.
2. Reduce the artifact to the cause, such as the hot function, the retainer chain to a GC root, or the loop that fires without input. Parse large artifacts in a subagent.
3. Prove the mechanism before you trust it. Inject instrumentation into the running page through the aside-browser skill, or hotfix the live code, to test the hypothesis.
4. Map the finding to a file, symbol, and line.
5. Write the throughput checkpoint as one line, `throughput checkpoint: n/a, read-only forensics`.

Reply with the signal captured, the finding, how you proved the mechanism, the source location, and the artifact paths. Hand off to Bug fix or Perf issue for the fix.
