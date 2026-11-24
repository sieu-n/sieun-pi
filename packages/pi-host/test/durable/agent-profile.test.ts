/**
 * A thread that belongs to an agent (an `agent.ref` doc in its root conversation) loads the agent's folder the way Prime loads its own
 * files: the brief is one more Prime context file in "# Project Context", after the AGENTS.md files and behind Prime's preamble, an edit
 * reaches the next request as a new context section alone, and the agent's harness store is the local store of the root's digest and of a
 * child conversation's harness section. A thread with no ref, or a ref of a bad shape, keeps its own store and no brief.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { AgentDoc, ROOT_CONVERSATION_ID, type AgentState, type EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PRIME_BASE_PROMPT } from "@sieun-pi/pi-family/preamble";
import { CHAT_BRIEF } from "../../../../legacy/prime/user-history/src/chat-brief.ts";
import { agentHarnessDir, AgentRoleDoc, briefFile, commInstructions, conversationHarnessDir, parseAgentRef, roleFields, ROOM_EXAMPLES, SHARED_STYLE_TEXT, workInstructions, type AppliedRole } from "../../src/durable/agent-profile.ts";
import { threadHarnessDir } from "../../src/durable/prime-harness.ts";
import { EDIT_MESSAGE_DESCRIPTION } from "../../src/durable/room-tools.ts";
import { primeModules, primePromptParts, primeResources } from "../../src/durable/prime-prompt.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-agent-profile-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);

/** The fixture agent dir, a repo cwd with its AGENTS.md, an empty bundled skills folder, and agent `vent`'s folder with a brief and a memory. */
function fixture(name: string) {
  const root = join(dir, name);
  const agentDir = join(root, "agent");
  cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), agentDir, { recursive: true });
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "# Repo rules\n\nRun npm test before a commit.\n");
  const bundled = join(root, "bundled");
  mkdirSync(bundled);
  const folder = join(root, "agents", "vent");
  mkdirSync(join(folder, "harness"), { recursive: true });
  writeFileSync(join(folder, "brief.md"), "# Vent\n\nYou own the vent crawler and its daily report.\n");
  const memory = { id: "vent_quota", kind: "memory", title: "Vent quota", content: "The vent crawler stops at 500 reads a day.", path: "general", scope: "local",
    reference: {}, arguments: {}, metadata: {}, source: "owner", created_at: "2026-10-29T00:00:00+00:00", updated_at: "2026-10-29T00:00:00+00:00", version: 1 };
  writeFileSync(join(folder, "harness", "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: {}, memory: { vent_quota: memory }, skill: {}, subagent: {} }, refinements: [] }, null, 2));
  return { agentDir, cwd, bundled, ledgerDir: join(agentDir, "browser-chat"), folder, ref: { agent: "ag_vent", dir: folder, role: "work" as const } };
}

const systemEntries = (entries: readonly EntryRecord[]) => entries.filter(entry => entry.kind === "pi.system").map(entry => (entry.model?.[0] as { sections?: Record<string, string | null> }).sections ?? {});
const userTexts = (messages: readonly Message[]) => messages.filter(message => message.role === "user").map(message => textOf(message.content));

/** One DurableThreads on the fixture whose faux model records each request, and answers `delegate` with a subagent call. */
function threadsOn(f: ReturnType<typeof fixture>, name: string) {
  const roots: Message[][] = [];
  const children: Message[][] = [];
  const respond = ({ messages }: { messages: Message[] }) => {
    if (userTexts(messages).some(text => text.includes("child task"))) {
      children.push(messages);
      return fauxAssistantMessage("child answer");
    }
    roots.push(messages);
    const last = textOf([...messages].reverse().find(m => m.role === "user")?.content ?? "");
    if (last === "delegate" && messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("subagent", { task: "child task" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("ok");
  };
  const threads = new DurableThreads({
    dir: join(dir, name, "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 20 }, () => respond));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL,
    defaultThinkingLevel: "off",
    defaultCwd: f.cwd,
    prompt: { agentDir: f.agentDir, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir },
  });
  const ask = async (id: string, text: string) => {
    const { submission } = await threads.submit(id, { text });
    assert.equal((await threads.wait(id, submission)).status, "done");
  };
  const systems = async (id: string, conversation?: number) => systemEntries((await threads.entries(id, { after: 0, limit: 500, ...(conversation ? { conversation } : {}) })).entries);
  return { threads, roots, children, ask, systems };
}

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("an agent.ref value reads as an agent only in its exact shape", () => {
  assert.deepEqual(parseAgentRef({ agent: "ag_vent", dir: "/a/vent", role: "job" }), { agent: "ag_vent", dir: "/a/vent", role: "job" });
  assert.deepEqual(parseAgentRef({ agent: "ag_t", dir: "/a/t", role: "work", test: true }), { agent: "ag_t", dir: "/a/t", role: "work", test: true });
  assert.deepEqual(parseAgentRef({ agent: "ag_t", dir: "/a/t", role: "work", test: "yes" }), { agent: "ag_t", dir: "/a/t", role: "work" });
  for (const bad of [null, "ag_vent", [], { agent: "", dir: "/a", role: "work" }, { agent: "a", dir: "relative", role: "work" }, { agent: "a", dir: "/a", role: "boss" }, { agent: "a", role: "work" }]) {
    assert.equal(parseAgentRef(bad), undefined, JSON.stringify(bad));
  }
  const file = "/d/threads/t.sqlite";
  assert.equal(conversationHarnessDir({ id: "t", file }, 1, undefined), threadHarnessDir(file, "t"));
  assert.equal(conversationHarnessDir({ id: "t", file }, 3, undefined), threadHarnessDir(file, "t-3"));
  assert.equal(conversationHarnessDir({ id: "t", file }, 3, { agent: "a", dir: "/a/vent", role: "work" }), "/a/vent/harness");
});

test("feedback on sw factory goes to agent factory: a tag in a group room, an agent message from a DM, and agent factory hands it to its work thread", () => {
  const other = commInstructions({ agent: "ag_search-product-misc", room: "ch_1a2b3c4d", work: "w1" });
  assert.match(other, /tag @agent factory for it/);
  assert.match(other, /ch_1a2b3c4d\/p12/);
  const dm = commInstructions({ agent: "ag_vent", room: "dm_vent", work: "w1" });
  assert.doesNotMatch(dm, /@agent factory/, "a DM post names no one");
  assert.match(dm, /receiver_name="agent factory · DM"/, "a DM sends it to agent factory's DM comm thread");
  assert.match(dm, /dm_vent\/p12/);
  for (const room of ["ch_1a2b3c4d", "dm_agent-factory"]) {
    const own = commInstructions({ agent: "ag_agent-factory", room, work: "w1" });
    assert.match(own, /Hand it to your work thread as a task with his words and the id of the post he means/);
    assert.doesNotMatch(own, /tag @agent factory|pass it to agent factory/);
    assert.match(own, /back to that comm thread/);
  }
});

test("owner feedback on how agents write reaches every agent: others bring it to agent factory, which puts it into the shared skill and role text", () => {
  for (const ref of [{ agent: "ag_vent", room: "dm_vent", work: "w1" }, { agent: "ag_search-product-misc", room: "ch_1a2b3c4d", work: "w1" }]) {
    const text = commInstructions(ref);
    assert.match(text, /A correction of how you wrote a post counts too, also when he aims it at you only/);
    assert.match(text, /save it for your own posts and also bring it to agent factory/);
    assert.match(text, /general rule, such as how agents write or behave in a room, also goes into the shared skills, as the refine-harness skill says \(#sw-factory-build p110\)/);
  }
  for (const room of ["ch_1a2b3c4d", "dm_agent-factory"]) {
    const own = commInstructions({ agent: "ag_agent-factory", room, work: "w1" });
    assert.ok(own.includes(SHARED_STYLE_TEXT));
    assert.match(own, /skills\/sw-factory\/SKILL\.md[\s\S]*never only in one agent's memory[\s\S]*blind fresh session \(c84\)/);
    assert.match(own, /is your agent's job: save it to memory and hand it to your work thread/);
  }
  assert.match(workInstructions({ agent: "ag_agent-factory", comm: "c-1" }), /yours to put into the sw-factory skill[\s\S]*agent-profile\.ts[\s\S]*blind fresh session[\s\S]*p110/);
  assert.doesNotMatch(workInstructions({ agent: "ag_vent", comm: "c-1" }), /sw-factory skill/);
});

test("a group comm thread, like a DM one, ends every turn with no text, since the room shows only its posts (p128 trace, 11-21)", () => {
  const group = commInstructions({ agent: "ag_search-product-misc", room: "ch_4c388a00", work: "w1" });
  assert.match(group, /The room shows nothing else you write, so end every turn with no text, also after a post, a reaction or a hand-over, and never sum up[\s\S]*replaces the base prompt's "state your final answer": in this room your last message after your tool calls is empty/);
  assert.match(commInstructions({ agent: "ag_vent", room: "dm_vent", work: "w1" }), /End a turn that posts nothing, such as one your reaction answers, with no text/);
});

test("a work thread names a channel comm thread as its main one when its agent has no DM comm thread, and keeps no tell_owner (p128 trace, 11-21)", () => {
  const ref = { agent: "ag_search-product-misc", dir: "/a/search-product-misc", role: "work" as const, comm: "5d50e997" };
  const fields = roleFields(ref);
  assert.deepEqual(fields.tools, { remove: ["tell_owner"] });
  assert.match(fields.instructions ?? "", /no tell_owner tool/);
  assert.match(fields.instructions ?? "", /Send it no acknowledgment or progress note/);
  assert.match(fields.instructions ?? "", /main comm thread 5d50e997 is the one in its DM, or else in its first room[\s\S]*to the main comm thread with `await agent_message\.send\(report, receiver_role="sibling", receiver_name="5d50e997"\)`/);
  assert.doesNotMatch(fields.instructions ?? "", /DM comm thread/);
});

test("a new agent's work thread holds the work role before its comm thread exists, so its first turn has no tell_owner (d3 recall, 11-22)", () => {
  const fields = roleFields({ agent: "ag_vent", dir: "/a/vent", role: "work" });
  assert.deepEqual(fields.tools, { remove: ["tell_owner"] });
  assert.match(fields.instructions ?? "", /You are agent ag_vent's work thread\. You do not talk with people, so you have no tell_owner tool[\s\S]*comm threads are not made yet, so answer an input that came from no comm thread in your last text/);
  assert.doesNotMatch(fields.instructions ?? "", /receiver_name="undefined"|main comm thread/);
});

test("a list of options opens with the pick, explains it with an example and how it fits, and gives each other one line (owner, #sw-factory-build p97)", () => {
  for (const room of ["dm_vent", "ch_1a2b3c4d"]) {
    assert.match(commInstructions({ agent: "ag_vent", room, work: "w1" }), /When you list options, open with your pick and its reason, explain that one with how it works, a concrete example and how it would fit, and give each other option one line on what it would mean for him/);
  }
});

test("a room post answers first, breaks into lines and keeps the agent's process to itself (owner p57, p159 and c234)", () => {
  for (const room of ["dm_vent", "ch_1a2b3c4d"]) {
    const text = commInstructions({ agent: "ag_vent", room, work: "w1" });
    assert.match(text, /Write each post like a coworker types in Slack: the answer first in a plain sentence/);
    // d4's 17:41 KST checklist run of 11-23 opened "All clear to ship." over a bullet that counted 7 uncommitted files and 8 untracked paths.
    // The example is no answer to a blind ask: with "three of the four are clear, but 15 files are uncommitted" in the text, all 5 checklist
    // reruns at 18:26 KST opened on those words, so they showed a copied line and not the rule.
    assert.match(text, /The answer holds for every result under it: when one result is not clean, the answer names it, as in "two of the three deploys are live, but staging fails its health check", never "all clear" over a bullet that says otherwise\./);
    assert.doesNotMatch(text, /three of the four are clear/);
    assert.match(text, /Put the answer on its own line and each further point on its own line or `- ` bullet, never in one paragraph\. A bullet stops at two sentences, also one that opens with yes or no: the yes or no and one fact that backs it are the two, and a further fact, such as one part of a count split by kind, goes in a nested `  - ` bullet or is left out\./);
    assert.match(text, /Keep your working plan and process to yourself \(c234\)\. A first reply gives the answer or one plain line on what he will get, never "I'll do X first, then Y" and never a checklist of your own steps\./);
    assert.match(text, /A checklist lists only results he cares about, each with its result, and you fill them in by editing that post with `edit_message`\./);
    assert.match(text, /A question to him leads with your own pick\./);
    assert.match(text, /Within about a minute \(c224\), reply with what you already know or one plain line on what he will get/);
    assert.match(text, /last edit of your post[\s\S]*carries the answer, that an edit only fills in results and the answer, never a status of its jobs or plans, and that it posts nothing new/);
    assert.match(text, /a question the work needs goes at its end, after your pick, never as a post of its own/);
    assert.match(text, /never what you are doing, such as "running the tests now" or "I'll run the tests"/);
    assert.match(text, /A question whether a setup or skill is set up right gets one answer line and one table of each piece[\s\S]*\(c225\)/);
    assert.match(text, /A yes or no question gets the fact he asked for and stops there: leave out what you are unsure of, or ask it as a question with your pick\./);
    assert.match(text, /A standing ask, such as "keep advising X", "always do Y" or "from now on Z", is such a rule, so save it the same way; a one-off task or answer is not memory\./);
    assert.match(text, /No labels, such as an opener like "Early read from the spec:"/);
    // A d4 blind run on 11-23 (ch_7c688239's set, 16:40 KST) put "The others:" over its other options, a label by the owner's "no labels".
    assert.match(text, /or a line of a word or two over a group of bullets like "The others:"/);
    // d4 blind runs on 11-23 and 11-25 opened "Not clean yet: ...", "Yes on this box: ..." and "Not quite in sync: ...", a verdict as a label.
    assert.match(text, /The answer line is a full sentence, never a short verdict before a colon: write "The upload works again on staging, and prod gets it with Thursday's release\.", never "Mostly fixed: /);
    assert.match(text, /give each other option one line on what it would mean for him, as more bullets of the same list\./);
    assert.match(text, /Keep ✅ and 👀 out of your post text too\./);
    assert.doesNotMatch(text, /your first post is the plan|tick each item|item per step|list what still needs proof|in the first few words|topic bullets|\b80 words|\b120 words/);
  }
  assert.doesNotMatch(EDIT_MESSAGE_DESCRIPTION, /checklist of what you will check|topic|at most 20/);
  assert.match(EDIT_MESSAGE_DESCRIPTION, /Use it to correct or complete a post[\s\S]*never a status of jobs or plans\. You can edit only your own posts/);
  assert.match(workInstructions({ agent: "ag_vent", comm: "c1" }), /an edit only fills in results and the answer, never a status of your jobs or plans/);
  assert.match(workInstructions({ agent: "ag_vent", comm: "c1" }), /because only that report has it take 👀 off\. /);
});

test("the role text shows real bad and good posts for each case, and the sw-factory skill shows the same pairs (owner, dm_agent-factory msg mwqvt8s4, c234)", () => {
  const skill = readFileSync(new URL("../../../../skills/sw-factory/SKILL.md", import.meta.url), "utf8");
  const quoted = (text: string) => text.split("\n").map(line => `> ${line}`.trimEnd()).join("\n");
  for (const room of ["dm_vent", "ch_1a2b3c4d"]) {
    const text = commInstructions({ agent: "ag_vent", room, work: "w1" });
    for (const pair of ROOM_EXAMPLES) {
      assert.ok(text.includes(`${pair.case}. Bad (${pair.bad.at}):\n${quoted(pair.bad.text)}\nGood (${pair.good.at}):\n${quoted(pair.good.text)}`), pair.case);
    }
    assert.match(text, /Several points, the post he called a model \(dm_agent-factory p63\):\n> yes, all three are running\./);
  }
  for (const pair of ROOM_EXAMPLES) {
    assert.ok(skill.includes(`\`\`\`markdown\n${pair.bad.text}\n\`\`\``) && skill.includes(`\`\`\`markdown\n${pair.good.text}\n\`\`\``), pair.case);
  }
  assert.ok(ROOM_EXAMPLES.some(pair => pair.bad.at === "#sw-factory-build p158"), "p158's plan of its own steps is a bad example (c234)");
  assert.ok(ROOM_EXAMPLES.some(pair => pair.bad.text.includes('{\\"t\\":\\"post\\"') || pair.bad.text.includes('{"t":"post"')), "raw log lines are a bad example");
});

test("a bullet stops at two sentences, shown by a real pair from no blind ask (owner p57 and mwqvt8s4; d4 rescore of 11-23)", () => {
  const sentences = (line: string) => line.replace(/^\s*- /, "").split(/(?<=[.!?])\s+/).filter(part => /\w/.test(part)).length;
  const pair = ROOM_EXAMPLES.find(example => example.case === "A bullet with three facts");
  assert.ok(pair, "the three-facts pair is in the examples");
  assert.ok(pair.bad.text.split("\n").some(line => sentences(line) >= 3), "the bad post holds a bullet of three sentences");
  assert.ok(pair.good.text.split("\n").every(line => sentences(line) <= 2), "every line of the good post holds at most two sentences");
  assert.match(pair.good.text, /\n  - /, "the good post nests the further facts");
  // On 11-23 all 5 checklist reruns opened on a rule example taken from their own ask, so this pair answers none of the list and checklist
  // asks of blind-replies.mjs: the checkout's uncommitted files and pi-host's comm-guard tests.
  assert.doesNotMatch(`${pair.bad.text}\n${pair.good.text}`, /uncommitted|untracked|comm[- ]guard|origin\/main|in sync/i);
});

test("a post to him says what he would see, names no metric key or job name, and lets its own board's id follow the thing as a chip (owner, dm_fable-auditor p15 and p16, 11-24; c145)", () => {
  for (const room of ["dm_vent", "ch_1a2b3c4d"]) {
    const text = commInstructions({ agent: "ag_vent", room, work: "w1" });
    assert.match(text, /Say what he would see, in words he uses, one fact per sentence: a post to him never names a metric key, a job name or another word we made up[\s\S]*never uses a duty or step id as the name of the thing/);
    assert.match(text, /your own board's id may follow as the chip the room makes of it \(c145\)[\s\S]*Another agent's ids stay out/);
    assert.match(text, /Unslop's rule to keep real names verbatim covers a name he uses himself/);
    assert.equal(text, commInstructions({ agent: "ag_vent", room, work: "w1" }), "the role text is the same on every build, so the cached prefix holds (c41)");
  }
  assert.match(workInstructions({ agent: "ag_vent", comm: "c1" }), /An edit reads like the comm thread's posts: what he would see, in his words, with no metric key or job name, and a duty or step id of your own board only after the thing it names\./);
  assert.ok(ROOM_EXAMPLES.some(pair => pair.bad.at === "dm_fable-auditor p14"), "the sweep post he called slop is a bad example");
});

test("an answer to an older post names it with reply_to and quotes nothing (owner, #dev-app-search-prospect p33, 11-21)", () => {
  for (const room of ["dm_vent", "ch_1a2b3c4d"]) {
    const text = commInstructions({ agent: "ag_vent", room, work: "w1" });
    assert.match(text, /When you answer an older post of his while a newer one sits below it, set `reply_to` to that older post and quote nothing from it/);
    assert.doesNotMatch(text, /quoted as `> /);
  }
});


test("an agent thread gets Prime's preamble first, the brief after the AGENTS.md files, and the agent's memory in its digest", async () => {
  const f = fixture("first");
  const { threads, roots, ask, systems } = threadsOn(f, "first");
  try {
    const thread = await threads.create({ name: "vent" });
    await threads.docPut(thread.id, "agent.ref", f.ref);
    await ask(thread.id, "how many reads a day?");
    const prompt = getCurrentSystemPrompt(roots[0]!);
    assert.ok(prompt.startsWith(`${PRIME_BASE_PROMPT}\n\n`), "Prime's preamble opens the prompt");
    const brief = join(f.folder, "brief.md");
    const [context] = (await systems(thread.id)).map(sections => sections.context);
    assert.equal(context, `# Project Context\n\nProject-specific instructions and guidelines:\n\n## ${join(f.agentDir, "AGENTS.md")}\n\n# Rules for every fixture session\n\n1. Read the unslop skill before your first prose.\n\n\n` +
      `## ${join(f.cwd, "AGENTS.md")}\n\n# Repo rules\n\nRun npm test before a commit.\n\n\n## ${brief}\n\n# Vent\n\nYou own the vent crawler and its daily report.\n\n\n`);

    const prime = await primeModules();
    const loader = new prime.DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, bundledSkillsDir: f.bundled, noExtensions: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const parts = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: threads.fileOf(thread.id), depth: 0, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir, agentBrief: briefFile(f.ref)!, primeOnly: true });
    const built = prime.buildSystemPrompt({ cwd: f.cwd, messagesPath: threads.fileOf(thread.id), skills: (await primeResources(f.agentDir, f.cwd, f.bundled)).skills, contextFiles: [...loader.getAgentsFiles().agentsFiles, { path: brief, content: "# Vent\n\nYou own the vent crawler and its daily report.\n" }],
      selectedTools: ["ipython", "search_history", "chat_board", "tell_owner", "correction_add", "poteto_mode"], promptGuidelines: [...CHAT_BRIEF, `Work in poteto-mode: read ${join(f.agentDir, "skills/poteto-mode/SKILL.md")} before your first step.`],
      allowRecursion: true, rlmDepth: 0, genericMcpServers: ["aside"] });
    assert.equal(parts.map(part => part.text).join("\n\n"), built);
    assert.ok(prompt.startsWith(built), "the thread sends Prime's builder's string, then the rules and corrections");

    const [digest, input] = userTexts(roots[0]!);
    assert.match(digest!, /^\[harness-digest\]\n/);
    assert.match(digest!, /## Agent vent's memory \(1 entries\)\n\n- \[agent:vent_quota\] memory: Vent quota: The vent crawler stops at 500 reads a day\./, "the agent's store is its own block");
    assert.match(digest!, /Local entries are agent vent's own memory/, "the scope lines name the agent's memory in place of Prime's session lines");
    assert.doesNotMatch(digest!, /belong to this Prime Agent session/);
    assert.match(digest!, /- \[global:fixture_memory\] /, "the global store still merges under the agent's");
    assert.equal(input, "how many reads a day?");
  } finally {
    await threads.shutdown();
  }
});

test("a brief edit sends only a new context section, an unchanged brief sends nothing, and a child gets the brief and the agent's store", async () => {
  const f = fixture("edit");
  const { threads, roots, children, ask, systems } = threadsOn(f, "edit");
  try {
    const thread = await threads.create({ name: "vent" });
    await threads.docPut(thread.id, "agent.ref", f.ref);
    await ask(thread.id, "first");
    await ask(thread.id, "second");
    let entries = await systems(thread.id);
    assert.equal(entries.length, 1, "an unchanged brief writes no new system entry");
    assert.equal(getCurrentSystemPrompt(roots[1]!), getCurrentSystemPrompt(roots[0]!));

    writeFileSync(join(f.folder, "brief.md"), "# Vent\n\nYou own the vent crawler, its daily report and its alerts.\n");
    await ask(thread.id, "third");
    entries = await systems(thread.id);
    assert.equal(entries.length, 2);
    assert.deepEqual(Object.keys(entries[1]!), ["context"], "only the context section changes");
    assert.match(entries[1]!.context!, /You own the vent crawler, its daily report and its alerts\.\n\n\n$/);
    const first = (messages: Message[]) => getSystemMessageText(messages[0] as Parameters<typeof getSystemMessageText>[0]);
    assert.equal(first(roots[2]!), first(roots[0]!), "the first system message, the cached prefix, is unchanged");

    await ask(thread.id, "delegate");
    const child = await until("the child's request", () => children[0]);
    const prompt = getCurrentSystemPrompt(child);
    assert.match(prompt, /Recursive agent depth: 1\n/);
    assert.ok(prompt.includes(`## ${join(f.folder, "brief.md")}\n\n# Vent\n\nYou own the vent crawler, its daily report and its alerts.\n`), "the child reads the brief");
    assert.match(prompt, /\[harness-digest\][\s\S]*- \[agent:vent_quota\] memory: Vent quota/, "the child's harness section shows the agent's store");
    assert.equal(agentHarnessDir(f.ref), join(f.folder, "harness"));
  } finally {
    await threads.shutdown();
  }
});

test("a thread with no agent.ref, or a bad one, keeps its own store and Prime's prompt with no brief", async () => {
  const f = fixture("none");
  const { threads, roots, ask } = threadsOn(f, "none");
  try {
    const plain = await threads.create({ name: "plain" });
    const bad = await threads.create({ name: "bad" });
    await threads.docPut(bad.id, "agent.ref", { agent: "ag_vent", dir: "vent", role: "work" });
    for (const thread of [plain, bad]) {
      const local = threadHarnessDir(threads.fileOf(thread.id), thread.id);
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: {}, memory: { own_note: { id: "own_note", kind: "memory", title: "Own note", content: "This thread's own store.", path: "general", scope: "local", version: 1, created_at: "2026-10-29T00:00:00+00:00", updated_at: "2026-10-29T00:00:00+00:00" } }, skill: {}, subagent: {} }, refinements: [] }));
      const at = roots.length;
      await ask(thread.id, "first");
      const parts = await primePromptParts({ agentDir: f.agentDir, cwd: f.cwd, messagesPath: threads.fileOf(thread.id), depth: 0, bundledSkillsDir: f.bundled, ledgerDir: f.ledgerDir, skip: new Set(["harness"]) });
      assert.equal(getCurrentSystemPrompt(roots[at]!), parts.map(part => part.text).join("\n\n"), "the prompt is the one a thread had before agents");
      assert.doesNotMatch(getCurrentSystemPrompt(roots[at]!), /vent crawler/);
      const [digest] = userTexts(roots[at]!);
      assert.match(digest!, /- \[local:own_note\] Own note/);
      assert.doesNotMatch(digest!, /vent_quota/);
    }
  } finally {
    await threads.shutdown();
  }
});

test("a role text that a release changed reaches the thread on its first open, in the instructions section alone", async () => {
  const f = fixture("release");
  const ref = { agent: "ag_vent", dir: f.folder, role: "comm", room: "dm_vent", work: "w-1" } as const;
  const before = threadsOn(f, "release");
  let id = "";
  try {
    id = (await before.threads.create({ name: "vent comm" })).id;
    await before.threads.docPut(id, "agent.ref", ref);
    const open = await before.threads.thread(id);
    await open.harness.commit(async tx => {
      (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID) as AgentState).instructions = "the role text of an older release";
      (await tx.doc(AgentRoleDoc, ROOT_CONVERSATION_ID) as AppliedRole).instructions = "the role text of an older release";
    }, BACKGROUND_CONTEXT);
    await before.ask(id, "first");
    assert.ok(getCurrentSystemPrompt(before.roots[0]!).includes("the role text of an older release"), "the old release sent its own role text");
  } finally {
    await before.threads.shutdown();
  }

  const after = threadsOn(f, "release");
  try {
    const entries = await after.systems(id);
    await after.ask(id, "second");
    const prompt = getCurrentSystemPrompt(after.roots[0]!);
    assert.ok(prompt.includes(commInstructions(ref)), "the request carries this release's role text");
    assert.doesNotMatch(prompt, /older release/);
    const added = (await after.systems(id)).slice(entries.length);
    assert.deepEqual(added.map(sections => Object.keys(sections)), [["instructions"]], "only the role section changes");
    assert.equal(added[0]!.instructions, `<instructions>\n${commInstructions(ref)}\n</instructions>`);
    const first = (messages: Message[]) => getSystemMessageText(messages[0] as Parameters<typeof getSystemMessageText>[0]);
    assert.equal(first(after.roots[0]!), first(before.roots[0]!), "the first system message, the cached prefix, is unchanged");
    const open = await after.threads.thread(id);
    assert.equal((await open.harness.snapshot(AgentRoleDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.instructions, commInstructions(ref));
  } finally {
    await after.threads.shutdown();
  }

  const again = threadsOn(f, "release");
  try {
    const entries = await again.systems(id);
    await again.ask(id, "third");
    assert.equal((await again.systems(id)).length, entries.length, "an unchanged role sends no new system entry");
  } finally {
    await again.threads.shutdown();
  }
});
