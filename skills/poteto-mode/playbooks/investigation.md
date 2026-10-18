### Investigation

For read-only questions such as "how does X work?", "why was Y built this way?", "are we sure about Z?", and "should we do X or Y?". The output is a cited answer or a recommendation, not a code change.

1. Route through the how skill, in Explain mode for narrow questions and Critique mode for "are we sure?". Add the why skill for questions about motivation.
2. Write the throughput checkpoint as one line, `throughput checkpoint: n/a, read-only investigation`.
3. Produce the how skill's output shape, or a recommendation with a tradeoffs table for a choice between options.

If the answer leads to a code change, hand back to the user and route to Bug fix or Feature.

Reply with the investigation output. For "are we sure?", give your judgment with reasons, and push back if the premise is wrong.
