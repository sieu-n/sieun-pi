# pi-family

pi-family holds the two tables that sieun-pi's Pi packages share inside one Node process: the agent registry and the kernel bridge.
Each table lives on `globalThis` under one `Symbol.for` key, so every extension loader in the process sees the same table.

| Export | What it holds |
|---|---|
| `@sieun-pi/pi-family/registry` | Each session's identity (name, parent, depth), its `deliver`, and the dormant rows of closed sessions. pi-rlm writes a child's identity before it opens the child, and pi-pool reads a session's tree root from it. |
| `@sieun-pi/pi-family/kernel-bridge` | The per-session handlers for kernel `host_request` methods, so pi-rlm's kernel reaches the methods other packages answer, such as pi-harness's `refine.*`. |
| `@sieun-pi/pi-family/paths` | A session's artifact dir in Prime's layout. |
| `@sieun-pi/pi-family/preamble` | Prime 0.9.8's base system prompt, which pooled Anthropic sessions need. |

It has no dependencies, and `paths` takes `getAgentDir` from `@earendil-works/pi-coding-agent` as a peer.
