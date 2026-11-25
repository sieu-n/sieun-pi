/**
 * A model call of a Python module of the ipython kernel as if it were a tool, such as `agent_message.send` or `attach_image`, gets
 * pi-durable's bare "Tool agent_message.send is not available". In the 7 days to 11-25 agents made 122 such calls, every one failed, and
 * 7,119 words of message text went nowhere (c245 scan, ~/work/comm-tools-doc/inefficiencies.md). This extension's `beforeRequest` hook
 * swaps that answer, in the request only, for one that says how to make the same call in ipython. The rewrite is the same on every
 * request, so the cached prompt prefix holds.
 */
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, type Extension } from "@earendil-works/pi-durable";

/** The kernel's pre-imported modules an agent reaches for as tools, each with the call that does the same in ipython. */
export const KERNEL_CALLS: Readonly<Record<string, string>> = {
  agent_message: 'await agent_message.send(text, receiver_role="parent")',
  agent_observe: "await agent_observe.list_agents()",
  attach_image: 'attach_image.attach_image("/absolute/path.png")',
  board: "board.wake(check=..., at=..., every=...)",
  wiki: "wiki.read(path)",
  websearch: "await websearch.search(query)",
  aside_browser: "help(aside_browser)",
  rlm: 'await rlm.spawn(task, name="worker")',
  refine: "await refine.run()",
  goal: "help(goal)",
  compact: "help(compact)",
  rlm_heartbeat: "help(rlm_heartbeat)",
  mcp: 'await mcp.list_tools("aside")',
};

const UNAVAILABLE = /^(?:<harness>\s*)?\[error\] Tool ([\w.]+) is not available\s*(?:<\/harness>)?\s*$/;

/** The hint for a call of `name` that pi-durable answered as unavailable, or undefined when `name` is no kernel module. */
export function kernelHint(name: string): string | undefined {
  const module = name.split(".")[0]!;
  const call = KERNEL_CALLS[module];
  if (!call) return undefined;
  return `${name} is a Python module in your ipython kernel, not a tool, so nothing ran. Make the same call inside the ipython tool, such as \`${call}\`.`;
}

/** The messages with each unavailable-tool answer for a kernel module swapped for its hint; the same array when none is. */
export function withKernelHints(messages: readonly Message[]): Message[] | undefined {
  let changed = false;
  const out = messages.map(message => {
    if (message.role !== "toolResult" || !message.isError) return message;
    const text = message.content.length === 1 && message.content[0]!.type === "text" ? message.content[0]!.text : "";
    const hit = UNAVAILABLE.exec(text.trim());
    const hint = hit && hit[1] === message.toolName ? kernelHint(message.toolName) : undefined;
    if (!hint) return message;
    changed = true;
    return { ...message, content: [{ type: "text" as const, text: hint }] };
  });
  return changed ? out : undefined;
}

export const KernelToolHint: Extension = defineExtension({
  name: "kernel-tool-hint",
  hooks: [hook(GenerationTask, {
    beforeRequest: async ({ messages }) => {
      const hinted = withKernelHints(messages as Message[]);
      return hinted ? { messages: hinted } : undefined;
    },
  })],
});
