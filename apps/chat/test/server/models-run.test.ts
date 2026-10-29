/**
 * Every model the chat's pickers offer must run on pi-host. On 10-29 gpt guy was made on openai-codex/gpt-6.1-sol, which
 * /api/models offers, while pi-host's durable threads only had the anthropic provider: both of its runs settled
 * `unanswered` with reason `no_model`, and the Agents view showed it as Failed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { durableModels } from "../../../../packages/pi-host/src/durable/models.ts";
import { MODELS } from "../../server/app.ts";

test("pi-host's durable threads can run every model /api/models offers", () => {
  const models = durableModels("models-run-test");
  const missing = MODELS.models.filter(m => !models.getModel(m.provider, m.id)).map(m => `${m.provider}/${m.id}`);
  assert.deepEqual(missing, []);
});

test("the default model runs on pi-host", () => {
  const [provider, id] = MODELS.default.model.split("/") as [string, string];
  assert.ok(durableModels("models-run-test").getModel(provider, id));
});
