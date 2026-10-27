import { basename } from "node:path";
import type { Verdict } from "./guard.ts";
import { SHELLS, lex, shellScript, stripHeredocs } from "./shell.ts";

/*
 * Owner rule c107 (2026-10-18): no memory, CPU, IO, task or priority cap on a box unless he asked for that one. The box parity duty
 * (legacy/prime/user-history/scripts/duties/box-parity.ts) counts each such setting as resource_limits_set. Every count so far came from a
 * hand-typed command: load-fakeprov.service with CPUQuota on 10-22 (board step p143), and `docker run --cpus 8` at 20:56Z, 21:35Z and 21:54Z
 * on 10-24, which made the duty read 2 at 21:55Z. This rule refuses such a command where it is a real argument of the program that sets it.
 * `heavy <size> -- <cmd>` stays allowed: the owner asked for it on 10-19 (memory layer 4 in deploy/linux/README.md).
 */
const PREFIX = "global-rules cap guard:";
export const CAP_TAIL =
	"Owner rule c107 keeps every memory, CPU, IO, task and priority cap off a box unless he asked for that one, and on 10-24 a hand-typed " +
	"`docker run --cpus 8` made the box parity duty read resource_limits_set 2. Drop the setting and size the run by its worker count instead, " +
	"such as `-e JOBS=N` for a container or a test runner's workers option. `heavy <size> -- <cmd>` stays allowed, since the owner asked for it " +
	"on 10-19. A cap the owner asks for goes into deploy/linux with his words, as setup-cpu.sh and heavy do.";

/** Docker run, create and update flags that set a cgroup limit, a CPU pin or a CPU share. */
const DOCKER_CAPS = new Set([
	"--cpus", "--cpu-quota", "--cpu-period", "--cpu-shares", "-c", "--cpu-rt-runtime", "--cpu-rt-period", "--cpuset-cpus", "--cpuset-mems",
	"-m", "--memory", "--memory-swap", "--memory-reservation", "--kernel-memory", "--pids-limit", "--blkio-weight", "--blkio-weight-device",
	"--device-read-bps", "--device-write-bps", "--device-read-iops", "--device-write-iops",
]);
/** Docker run and create flags that take no value; every other flag takes one, unless written as `--flag=value`. */
const DOCKER_BOOL = new Set([
	"-d", "--detach", "-i", "--interactive", "-t", "--tty", "--rm", "--privileged", "--init", "--read-only", "-P", "--publish-all",
	"--oom-kill-disable", "--no-healthcheck", "--help", "-q", "--quiet", "--sig-proxy", "--use-api-socket", "--disable-content-trust",
]);
const DOCKER_GLOBAL_VALUE = new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]);

/** systemd properties that set a cap, a weight, a pin or a priority (box-parity.ts LIMIT_PROPS plus their older and startup forms). */
const UNIT_CAP = /^(?:CPUQuota|CPUQuotaPeriodSec|CPUWeight|StartupCPUWeight|CPUShares|StartupCPUShares|AllowedCPUs|StartupAllowedCPUs|AllowedMemoryNodes|CPUAffinity|Memory(?:Max|High|Low|Min|SwapMax|ZSwapMax|Limit)|StartupMemory\w+|TasksMax|IO\w*(?:Max|Weight)|BlockIO\w+|Nice|CPUSchedulingPolicy|CPUSchedulingPriority|IOSchedulingClass|IOSchedulingPriority)$/;
/** A value that removes a cap instead of setting one, so `systemctl set-property <unit> MemoryMax=infinity` passes. */
const UNSET = /^(?:infinity|)$/;
const RUN_VALUE = new Set([
	"-p", "--property", "-u", "--unit", "--description", "--slice", "-E", "--setenv", "--uid", "--gid", "-M", "--machine", "-H", "--host",
	"--working-directory", "--on-active", "--on-boot", "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar",
	"--timer-property", "--path-property", "--socket-property", "--service-type", "--nice", "-C", "--capsule",
]);
const SSH_VALUE = new Set("bcDEeFIiJLlmOoPpQRSWwB".split("").map((c) => `-${c}`));
const PASS = new Set(["command", "exec", "time", "nohup", "setsid", "builtin", "caffeinate", "then", "else", "elif", "do", "while", "until", "!", "{"]);

const capProps = (props: string[]): string[] =>
	props.filter((p) => { const at = p.indexOf("="); return at > 0 && UNIT_CAP.test(p.slice(0, at)) && !UNSET.test(p.slice(at + 1)); });

/** The words after `--` when present, else after the first `skip` positional words. */
function after(words: string[], skip: number): string[] {
	const dash = words.indexOf("--");
	if (dash !== -1) return words.slice(dash + 1);
	let seen = 0;
	for (let i = 0; i < words.length; i++) {
		if (words[i].startsWith("-")) continue;
		if (seen++ === skip) return words.slice(i);
	}
	return [];
}

/** Docker run, create or update: the cap flags among the options before the image (run, create) or the container names (update). */
function dockerCaps(args: string[]): string[] {
	const found: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const w = args[i];
		if (w === "--") break;
		if (!w.startsWith("-") || w === "-") break;
		if (w.startsWith("--")) {
			const name = w.split("=")[0];
			if (DOCKER_CAPS.has(name)) found.push(name);
			if (!w.includes("=") && !DOCKER_BOOL.has(name)) i++;
			continue;
		}
		const letters = w.slice(1);
		for (let k = 0; k < letters.length; k++) {
			const flag = `-${letters[k]}`;
			if (DOCKER_CAPS.has(flag)) found.push(flag);
			if (DOCKER_BOOL.has(flag)) continue;
			if (k === letters.length - 1) i++;
			break;
		}
	}
	return found;
}

function docker(args: string[]): string | null {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) i += DOCKER_GLOBAL_VALUE.has(args[i]) ? 2 : 1;
	let sub = args[i];
	if (sub === "container") sub = args[++i];
	if (sub !== "run" && sub !== "create" && sub !== "update") return null;
	const found = dockerCaps(args.slice(i + 1));
	return found.length ? `a container limit (${[...new Set(found)].join(", ")})` : null;
}

/** systemd-run: its cap properties, and the command it starts. */
function systemdRun(args: string[]): { caps: string[]; command: string[] } {
	const props: string[] = [];
	let nice = false;
	let i = 0;
	for (; i < args.length; i++) {
		const w = args[i];
		if (w === "--") { i++; break; }
		if (!w.startsWith("-")) break;
		if (w === "-p" || w === "--property") { props.push(args[++i] ?? ""); continue; }
		if (w.startsWith("--property=")) { props.push(w.slice(11)); continue; }
		if (/^-p./.test(w)) { props.push(w.slice(2)); continue; }
		if (w === "--nice" || w.startsWith("--nice=")) nice = true;
		if (RUN_VALUE.has(w)) i++;
	}
	return { caps: [...capProps(props), ...(nice ? ["--nice"] : [])], command: args.slice(i) };
}

function positionals(args: string[], valued: Set<string>): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (valued.has(args[i])) i++;
		else if (!args[i].startsWith("-")) out.push(args[i]);
	}
	return out;
}

/** Refuses one program's argv when it sets a cap, and judges the command it starts in turn. */
function judgeArgv(argv: string[], depth: number, out: Verdict[]): void {
	if (depth > 6) return;
	let k = 0;
	while (k < argv.length) {
		const w = argv[k];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PASS.has(w)) { k++; continue; }
		if (w === "sudo" || w === "doas") { k++; while (k < argv.length && argv[k].startsWith("-")) k += argv[k] === "-u" || argv[k] === "--user" ? 2 : 1; continue; }
		if (w === "env") { k++; while (k < argv.length && (argv[k].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[k]))) k += argv[k] === "-u" ? 2 : 1; continue; }
		break;
	}
	const eff = argv.slice(k);
	if (!eff.length) return;
	const name = basename(eff[0]);
	const args = eff.slice(1);
	const refuse = (what: string) => out.push({ rule: "cap", command: eff.join(" "), reason: `${PREFIX} \`${eff.join(" ").slice(0, 300)}\` sets ${what}. ${CAP_TAIL}` });
	switch (name) {
		case "nice":
			if (args.length && !args.every((a) => a === "--help" || a === "--version")) refuse("a CPU priority (nice)");
			return;
		case "renice":
			if (args.length && !args.every((a) => a === "--help" || a === "--version")) refuse("a CPU priority (renice)");
			return;
		case "cpulimit":
			if (args.length) refuse("a CPU limit (cpulimit)");
			return;
		case "ionice":
			if (args.some((a) => /^(?:-c|--class|-n|--classdata)/.test(a)) || positionals(args, new Set(["-p", "--pid", "-P", "--pgid", "-u", "--uid"])).length) refuse("an IO priority (ionice)");
			return;
		case "taskset":
			if (positionals(args, new Set()).length >= 2) refuse("a CPU pin (taskset)");
			return;
		case "heavy":
			judgeArgv(after(args, 1), depth + 1, out);
			return;
		case "choom":
			judgeArgv(after(args, args[0] === "-n" ? 1 : 0), depth + 1, out);
			return;
		case "timeout": {
			let i = 0;
			while (i < args.length && args[i].startsWith("-")) i += args[i] === "-s" || args[i] === "-k" || args[i] === "--signal" || args[i] === "--kill-after" ? 2 : 1;
			judgeArgv(args.slice(i + 1), depth + 1, out);
			return;
		}
		case "stdbuf": {
			let i = 0;
			while (i < args.length && args[i].startsWith("-")) i += /^-[ioe]$/.test(args[i]) ? 2 : 1;
			judgeArgv(args.slice(i), depth + 1, out);
			return;
		}
		case "docker":
		case "podman": {
			const what = docker(args);
			if (what) refuse(what);
			return;
		}
		case "systemd-run": {
			const run = systemdRun(args);
			if (run.caps.length) refuse(`a unit limit (${run.caps.join(", ")})`);
			judgeArgv(run.command, depth + 1, out);
			return;
		}
		case "systemctl": {
			const at = args.indexOf("set-property");
			const caps = at === -1 ? [] : capProps(args.slice(at + 1));
			if (caps.length) refuse(`a unit limit (${caps.join(", ")})`);
			return;
		}
		case "ssh": {
			let i = 0;
			while (i < args.length && args[i].startsWith("-")) i += SSH_VALUE.has(args[i]) ? 2 : 1;
			const remote = args.slice(i + 1).join(" ");
			if (remote) judge(remote, depth + 1, out);
			return;
		}
	}
	if (SHELLS.has(name)) {
		const script = shellScript(eff);
		if (script) judge(script, depth + 1, out);
	}
}

function judge(text: string, depth: number, out: Verdict[]): void {
	if (depth > 6) return;
	const { commands, nested } = lex(stripHeredocs(text));
	for (const argv of commands) judgeArgv(argv, depth, out);
	for (const inner of nested) judge(inner, depth + 1, out);
}

/** One verdict per command in `text` that sets a resource cap (c107). */
export function judgeCaps(text: string): Verdict[] {
	const out: Verdict[] = [];
	judge(text, 0, out);
	return out;
}
