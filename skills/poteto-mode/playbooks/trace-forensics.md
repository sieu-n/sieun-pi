### Trace forensics

For a captured `.cpuprofile`, `Trace-*.json.gz`, `Spindump.txt`, or `.heapsnapshot` with a question about why something is slow, stuck, leaking, or crashing. Read the artifact. Do not re-run the capture.

1. Identify the format and load it. Parse large artifacts in a subagent.
2. Load the samples, frames, or nodes into sqlite so you can query them.
3. Find the frames that hold the most time and walk the call tree to the hot path. For a leak, follow the retainer chain to a GC root. For a spindump, find the stuck thread and its wait reason.
4. Map the hot frame to file, symbol, and line from the artifact's symbols. If the artifact has no symbols, say so.
5. Diff against a paired before capture if you have one. Without one, call the finding the strongest hypothesis the artifact supports.
6. Write the throughput checkpoint as one line, `throughput checkpoint: n/a, read-only forensics`.

Reply with the artifact and format, the finding, the source location, the artifact paths, and whether a paired capture confirmed it. Hand off to Bug fix or Perf issue for the fix.
