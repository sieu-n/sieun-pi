import type { Skill } from "@earendil-works/pi-coding-agent";
import type { PythonSkill } from "./python.ts";

export { PRIME_BASE_PROMPT as BASE_PROMPT } from "../../shared/preamble.ts";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The skill list in Prime's format, with `type` and `python_import`, since Pi lists skills only when `read` or `bash` is active. */
export function skillsSection(skills: Skill[], python: PythonSkill[]): string {
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use ipython to read a skill's file when the task matches its description.",
    "Skills with a python_import are pre-imported in the persistent Python kernel and can be called directly by that import name.",
    "When a skill file references a relative path, resolve it against the skill directory.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    if (skill.disableModelInvocation) continue;
    const py = python.find(p => p.dir === skill.baseDir);
    lines.push("  <skill>", `    <name>${escapeXml(skill.name)}</name>`, `    <type>${py ? "python" : "markdown"}</type>`);
    if (py) lines.push(`    <python_import>${py.importName}</python_import>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`, `    <location>${escapeXml(skill.filePath)}</location>`, "  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** The RLM section of the system prompt, rebuilt from Prime 0.9.8's base prompt and call contract. */
export function rlmSection(skills: PythonSkill[]): string {
  const lines = [
    "Work in the persistent `ipython` REPL, which is your control environment for reading and editing files, running commands, keeping state and delegating.",
    "Variables, imports and helpers persist across cells, through compaction, and are revived on a best-effort basis when the session is reopened.",
    "",
    "Run shell commands with `bash(command)`. It starts the command in the background and returns a handle at once: use `h.pid`, `h.running`, `h.tail(n)`, `h.output()`, `h.poll()`, `h.kill()`, and `await h` for the finished result with exit_code, output and duration. Each `bash()` call is its own process, while `os.chdir(...)` and `os.environ[...]` persist in the kernel.",
    "For slow work, start it, keep its handle, and end your turn. When a handle outlives its cell and finishes, you get a `[bash-done pid:<pid> exit:<code>]` notice that starts a new turn; inspect the saved handle and continue. Do not poll with `time.sleep()` or a long blocking `await`.",
    "",
    "Spawn a child agent with `handle = await rlm.spawn('sub-task', name='worker')`. It returns `rlm_child_id`, `name`, `session_dir` and `model` once the child is admitted, never the child's answer.",
    "Results arrive only as agent messages or files. A child replies with `await agent_message.send(message, receiver_role='parent')`, and a child that ends without replying sends a `[child-exited: ...]` notice with its last text.",
    "Use `await rlm.list_subagents()` to find children, `await rlm.collect(targets, timeout_ms=...)` for their results without being steered, `await rlm.delete_subagent(child)` when a child's context is no longer needed, and `await rlm.find_models(query)` to pick another model for `rlm.spawn(..., model='provider/id')`.",
    "`rlm.harness` is the persisted continual-harness ledger of prompt notes, memories, skills and subagent specs.",
  ];
  if (skills.length) lines.push("", `Pre-imported Python skill modules: ${skills.map(s => `\`${s.importName}\``).join(", ")}. Read a skill's SKILL.md before you call it.`);
  return lines.join("\n");
}

export function childSection(parentName: string | undefined): string {
  return [
    `You are a child agent spawned by ${parentName ?? "your parent agent"}. Task prompts are labeled \`[task from parent]\`.`,
    'When a task calls for an answer, reply explicitly with `await agent_message.send(message, receiver_role="parent")`. Not every message or task needs a reply; continue cleanup after sending and go idle normally.',
    "For long-running work, report brief progress with `await rlm.progress_note('...')` (at most 512 characters, throttled to about one note per 10 seconds); the parent sees notes without needing a reply.",
  ].join("\n");
}
