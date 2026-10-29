/**
 * Every model the chat's pickers offer must run on pi-host. On 10-29 gpt guy was made on openai-codex/gpt-6.1-sol, which
 * /api/models offers, while pi-host's durable threads only had the anthropic provider: both of its runs settled
 * `unanswered` with reason `no_model`, and the Agents view showed it as Failed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MODELS } from "../../server/app.ts";

// pi-host's registry, imported by a path tsc does not follow, because apps/chat does not install pi-host's pi-ai dependency.
const source = "../../../../packages/pi-host/src/durable/models.ts";
const { durableModels } = (await import(source)) as { durableModels: (threadId: string) => { getModel(provider: string, id: string): { input: string[] } | undefined } };

test("pi-host's durable threads can run every model /api/models offers", () => {
  const models = durableModels("models-run-test");
  const missing = MODELS.models.filter(m => !models.getModel(m.provider, m.id)).map(m => `${m.provider}/${m.id}`);
  assert.deepEqual(missing, []);
});

test("the default model runs on pi-host", () => {
  const [provider, id] = MODELS.default.model.split("/") as [string, string];
  assert.ok(durableModels("models-run-test").getModel(provider, id));
});

// Prime's catalog (models.bundled.json in its release) gives each of these models text and image input. On 10-29 attach_image in a
// pi-host thread said claude-opus-5-5 "does not support vision", because pi-host's model.info left the input types out.
test("every model /api/models offers takes images on pi-host, as in Prime", () => {
  const models = durableModels("models-run-test");
  const inputs = Object.fromEntries(MODELS.models.map(m => [`${m.provider}/${m.id}`, models.getModel(m.provider, m.id)?.input]));
  assert.deepEqual(inputs, Object.fromEntries(MODELS.models.map(m => [`${m.provider}/${m.id}`, ["text", "image"]])));
});
