# Wiki engine

This app is the wiki server on us-metal02. It stores pages as HTML with a `<!--wiki {json}-->` meta block, serves them under the base path `/wiki` on 127.0.0.1:5176, and answers the agent API at `/wiki/api/agent/*`. It moved here from auto-sns-agent `apps/llm-wiki` on 2026-11-03 (step p1374).

## Where things live

The engine reads one config file, `~/.config/sieun-pi/wiki.json`, or the file that `WIKI_CONFIG` names. `src/lib/wiki-config.mjs` documents every key. The content root holds `sessions/`, the curated spaces and `.wiki/wiki.db`. The `agents/` mount serves `~/.pi/agent/agents/<slug>/` and leaves out each `harness/` folder.

A session opens under `sessions/YYYY/MM/DD/hhmm-<slug>/`. A job opens under `agents/<slug>/jobs/YYYY/MM/DD/hhmm-<slug>/` when `POST /api/agent/sessions` gets `root: "agents/<slug>/jobs"`. The log frontmatter keeps `agent`, `conversation`, `parent` and `host`.

`server.mjs` puts `/wiki` in front of any path that lacks it, so an old link such as `:5176/page/apps/search/index.html` still opens.

## Run, test and release

1. Run the unit tests with `npm test`, and the HTTP tests against the live engine with `npm run test:content`.
2. Run the type check with `heavy 8G -- npm run check` and the build with `heavy 8G -- npm run build`.
3. Push the commit to main, then release it with `node scripts/release-wiki.mjs <sha>` from the repo root.

The unit is `deploy/linux/sieun-pi-wiki.service`.

The product specs and their runner stay in auto-sns-agent `apps/llm-wiki/specs`, because its CI runs them. The `/specs` page reads them through the `specsDir` key.
