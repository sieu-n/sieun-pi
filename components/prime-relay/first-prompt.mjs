import { Transform } from "node:stream";

/**
 * The field a client sets on a `create` command, bare or inside a command envelope, to have the relay send that session's first `prompt` the
 * moment the daemon answers the create: the prompt's fields without `type` and `activeSessionId`, with `ownerTurn: true` to mark the new
 * session's owner turn. The relay takes the field off, so the daemon
 * gets the create it always got, and it holds the create's answer until the prompt's answer comes, which it adds as `relayFirstPrompt`
 * (`{ success: true }` or `{ success: false, error }`). A client whose answer has no such field talks to a relay without this and sends the
 * prompt itself. A client on another box saves one round trip: on 10-20 a new Mac thread's create answer reached us-metal02 and its prompt came
 * back 190 ms later, while the session waited.
 */
export const FIRST_PROMPT_FIELD = "relayFirstPrompt";
const KEY = Buffer.from(`"${FIRST_PROMPT_FIELD}"`);
const NEWLINE = 10;

/** Splits a byte stream into whole lines, calling `line` for each line with its newline and keeping a partial line for the next chunk. */
function lineSplitter(line) {
  let parts = [];
  return {
    write(chunk, push) {
      if (chunk.indexOf(NEWLINE) < 0) { parts.push(chunk); return; }
      const data = parts.length ? Buffer.concat([...parts, chunk]) : chunk;
      parts = [];
      const last = data.lastIndexOf(NEWLINE);
      if (last + 1 < data.length) parts.push(data.subarray(last + 1));
      line(data.subarray(0, last + 1), push);
    },
    flush(push) { if (parts.length) push(Buffer.concat(parts)); parts = []; },
  };
}

const commandOf = message => message?.type === "command" && message.command && typeof message.command === "object" ? message.command : message;
const lineOf = message => Buffer.from(JSON.stringify(message) + "\n");

/**
 * Two streams for one tunnel. `outbound` carries the client's bytes to the daemon and takes `relayFirstPrompt` off each create; `inbound` carries
 * the daemon's bytes to the client, holds each such create's answer, sends the prompt (and its result's ack, for an enveloped command) on
 * `outbound`, and lets the answer go once the prompt's answer is in. Every other line passes as it came, in order.
 */
export function firstPromptTunnel(log = () => {}) {
  /** create command id -> { envelope, prompt } while the create runs; prompt command id -> held create answer while the prompt runs. */
  const creates = new Map();
  const prompts = new Map();
  const send = (envelope, id, command) => {
    outbound.push(lineOf(envelope ? { type: "command", id, protocol: envelope.protocol, clientId: envelope.clientId, command: { ...command, id } } : { ...command, id }));
  };
  const out = lineSplitter((lines, push) => {
    if (lines.indexOf(KEY) < 0) return push(lines);
    for (let at = 0, end = lines.indexOf(NEWLINE); end >= 0; at = end + 1, end = lines.indexOf(NEWLINE, at)) {
      const line = lines.subarray(at, end + 1);
      if (line.indexOf(KEY) < 0) { push(line); continue; }
      let message;
      try { message = JSON.parse(line.toString("utf8")); } catch { push(line); continue; }
      const command = commandOf(message);
      const prompt = command?.[FIRST_PROMPT_FIELD];
      if (!command || command.type !== "create" || !(FIRST_PROMPT_FIELD in command)) { push(line); continue; }
      delete command[FIRST_PROMPT_FIELD];
      const id = message.id ?? command.id;
      if (typeof id === "string" && prompt && typeof prompt === "object" && typeof prompt.message === "string") {
        creates.set(id, { envelope: message.type === "command" ? message : null, prompt });
      } else log(`first prompt: ignored on create ${String(id).slice(0, 40)}`);
      push(lineOf(message));
    }
  });
  const outbound = new Transform({
    transform(chunk, _encoding, done) { out.write(chunk, data => this.push(data)); done(); },
    flush(done) { out.flush(data => this.push(data)); done(); },
  });
  const answer = (line, push) => {
    let message;
    try { message = JSON.parse(line.toString("utf8")); } catch { return push(line); }
    if (message?.type !== "response" || typeof message.id !== "string") return push(line);
    const create = creates.get(message.id);
    if (create && message.command === "create") {
      creates.delete(message.id);
      const activeSessionId = message.success ? message.data?.activeSessionId : undefined;
      if (typeof activeSessionId !== "string") return push(line);
      const id = `relay_first_${message.id}`;
      prompts.set(id, { held: message, envelope: create.envelope });
      // `ownerTurn: true` names the session the create just made, which the owner-turn stage after this one marks.
      const ownerTurn = create.prompt.ownerTurn === true ? { ownerTurn: message.data.sessionId } : {};
      send(create.envelope, id, { ...create.prompt, ...ownerTurn, type: "prompt", activeSessionId });
      return;
    }
    const prompt = prompts.get(message.id);
    if (!prompt) return push(line);
    prompts.delete(message.id);
    if (prompt.envelope) send(prompt.envelope, `${message.id}_ack`, { type: "ack_result", commandId: message.id });
    if (!message.success) log(`first prompt for ${prompt.held.data.activeSessionId}: ${String(message.error).slice(0, 200)}`);
    push(lineOf({ ...prompt.held, [FIRST_PROMPT_FIELD]: message.success ? { success: true } : { success: false, error: String(message.error ?? "the prompt failed") } }));
  };
  const inn = lineSplitter((lines, push) => {
    if (!creates.size && !prompts.size) return push(lines);
    for (let at = 0, end = lines.indexOf(NEWLINE); end >= 0; at = end + 1, end = lines.indexOf(NEWLINE, at)) {
      const line = lines.subarray(at, end + 1);
      // Only answers to a held id are read; token updates and every other line pass unparsed.
      const watched = [...creates.keys(), ...prompts.keys()].some(id => line.indexOf(`"id":"${id}"`) >= 0);
      if (watched) answer(line, push); else push(line);
    }
  });
  const inbound = new Transform({
    transform(chunk, _encoding, done) { inn.write(chunk, data => this.push(data)); done(); },
    flush(done) { inn.flush(data => this.push(data)); done(); },
  });
  return { outbound, inbound };
}
