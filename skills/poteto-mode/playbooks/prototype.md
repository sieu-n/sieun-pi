### Prototype

For "prototype", "mock it up", "sketch this", or "try this layout", and for any question that running a small sketch would answer faster than asking the user. The prototype is throwaway, and the real build follows Feature. Favor speed over polish, and offer variations the user did not ask for.

1. Name the decision the prototype exists to make. If there is none, route to Feature.
2. When the design space is open, collect prior art and let the user pick directions. Skip this when the direction is set.
3. Build in a scratch directory outside production source. For a visual question, use plain HTML, CSS, and JS with CDN dependencies and a hot-reload server. For a behavior or timing question, write the smallest script that exercises it. Skip tests and abstractions.
4. Put competing variants behind one labeled switcher, such as buttons or a key press.
5. Check each variant on the real surface. Screenshot visual variants. Log the timing or output for behavior questions.
6. Present the variants, tradeoffs, and a recommendation. Hand the chosen direction to Feature or the architect skill.

Reply with the variants, the evidence, the tradeoffs, your recommendation, and the scratch path. State that the prototype is throwaway.
