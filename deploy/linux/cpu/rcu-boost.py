#!/usr/bin/python3 -B
"""Runs a thread that an RCU stall warning names, so a preempted RCU reader always runs again. CPU layer 3 of deploy/linux/README.md.

The owner's t84 answer on 10-19 put CPU priority on us-metal02 under https://cho.sh/ko/1983DC and under the chat metal-management.
On 10-20 a clickhouse thread on us-metal02 was preempted inside an RCU read section while it unmapped memory on exit, and from 11:23Z to 13:06Z it
got no CPU. Grace period g=220375749 never ended, so every rtnl, netns, runc and ss call that waits for one hung, load reached 907 and sshd stopped
answering (~/work/box-rcu-stall/FINDINGS.md). The Ubuntu 7.0.0-38 kernel runs PREEMPT_RCU without CONFIG_RCU_BOOST, so nothing raised the reader's
priority. Its scheduler also still carries 6d71a9c61604, which starves a task on a CPU where a busy task pinned there belongs to a cgroup whose
weight changes often; upstream reverted it in 101f3498b4bd for v7.1 (https://lkml.iu.edu/2604.1/10627.html). Sixteen or more busy loops pinned to
CPU 3 from Prime bash() calls ran in prime-agent-daemon.service then.

This service does the boost from user space. It sets the kernel's stall warning delay to STALL_TIMEOUT_S and reads /dev/kmsg. When a warning names a
blocked task (`P<tid>`), it sets that thread to SCHED_FIFO at BOOST_PRIORITY, which runs it ahead of every fair task on its CPU. Once the thread has
run, it gets its own policy back. A thread in exit keeps FIFO until it is gone, because it only has its exit left and would starve again.
The service runs at SCHED_FIFO itself (rcu-boost.service), so the starvation it fixes cannot hold it off the CPU.
"""
import errno
import json
import os
import re
import select
import sys
from dataclasses import asdict, dataclass

# Upstream's default CONFIG_RCU_CPU_STALL_TIMEOUT (kernel/rcu/Kconfig.debug). Ubuntu ships 60, so on 10-20 the stall ran 60 s before its first warning.
STALL_TIMEOUT_S = 21
# The lowest RT priority, so the RT threads the box already runs, multipathd (RR 10) and psimon (FIFO 1), keep their place.
BOOST_PRIORITY = 1
# A boosted thread is checked once a second. One that never blocks holds its CPU at most that long past its first run, and the kernel's RT
# throttle (sched_rt_runtime_us 950000 of 1000000) and fair server (50 ms of every 1 s) leave fair tasks their share even then.
CHECK_S = 1.0
STALL_PARAM = "/sys/module/rcupdate/parameters/rcu_cpu_stall_timeout"
STATE_FILE = "/run/rcu-boost/boosted.json"
PF_EXITING = 0x4
FAIR = {os.SCHED_OTHER, os.SCHED_BATCH, os.SCHED_IDLE}

_TASK = re.compile(r"\bP(\d+)\b")
_TASKS_ONLY = re.compile(r"^\s*(P\d+/\S*\s*)+$")


def blocked_tids(message: str) -> list[int]:
    """The threads an RCU stall warning names as blocking a grace period, in the normal and expedited forms and a pr_cont split of either."""
    if ("rcu" in message and ("Tasks blocked on" in message or "detected expedited stalls" in message)) or _TASKS_ONLY.match(message):
        return [int(tid) for tid in _TASK.findall(message)]
    return []


@dataclass(frozen=True)
class Boost:
    """A thread this service set to FIFO: its own policy and priority to give back, its CPU time at the boost, and its start time against tid reuse."""
    policy: int
    priority: int
    ran_ns: int
    started: int


@dataclass(frozen=True)
class Seen:
    """What /proc shows of a live thread now."""
    exiting: bool
    ran_ns: int
    started: int


def step(boost: Boost, seen: Seen | None) -> str:
    """drop when the thread is gone, keep while it is exiting or has not run yet, and restore once it has run."""
    if seen is None or seen.started != boost.started:
        return "drop"
    if seen.exiting:
        return "keep"
    return "restore" if seen.ran_ns > boost.ran_ns else "keep"


class Proc:
    def seen(self, tid: int) -> Seen | None:
        try:
            with open(f"/proc/{tid}/stat") as f:
                stat = f.read()
            with open(f"/proc/{tid}/schedstat") as f:
                ran_ns = int(f.read().split()[0])
        except (OSError, ValueError, IndexError):
            return None
        fields = stat[stat.rindex(")") + 2:].split()
        if fields[0] in ("Z", "X"):
            return None
        return Seen(exiting=bool(int(fields[6]) & PF_EXITING), ran_ns=ran_ns, started=int(fields[19]))

    def describe(self, tid: int) -> str:
        def first_line(path: str) -> str:
            try:
                with open(path) as f:
                    return f.readline().strip()
            except OSError:
                return "?"
        return f"{first_line(f'/proc/{tid}/comm')} in {first_line(f'/proc/{tid}/cgroup').removeprefix('0::')}"


class Sched:
    def get(self, tid: int) -> tuple[int, int]:
        return os.sched_getscheduler(tid), os.sched_getparam(tid).sched_priority

    def set(self, tid: int, policy: int, priority: int) -> None:
        os.sched_setscheduler(tid, policy, os.sched_param(priority))


class Booster:
    def __init__(self, proc, sched, log, state_file: str | None = STATE_FILE):
        self.proc, self.sched, self.log, self.state_file = proc, sched, log, state_file
        self.boosts: dict[int, Boost] = {}

    def on_message(self, message: str) -> None:
        for tid in blocked_tids(message):
            if tid in self.boosts:
                continue
            seen = self.proc.seen(tid)
            try:
                policy, priority = self.sched.get(tid)
                if seen is None or policy & ~os.SCHED_RESET_ON_FORK not in FAIR:
                    continue
                self.sched.set(tid, os.SCHED_FIFO | os.SCHED_RESET_ON_FORK, BOOST_PRIORITY)
            except OSError:
                continue
            self.boosts[tid] = Boost(policy, priority, seen.ran_ns, seen.started)
            self.log(f"boosted tid {tid} ({self.proc.describe(tid)}) to SCHED_FIFO {BOOST_PRIORITY}{' while it exits' if seen.exiting else ''}: {message.strip()}")
            self.save()

    def settle(self) -> None:
        changed = False
        for tid, boost in list(self.boosts.items()):
            action = step(boost, self.proc.seen(tid))
            if action == "keep":
                continue
            del self.boosts[tid]
            changed = True
            if action == "drop":
                self.log(f"tid {tid} is gone")
                continue
            try:
                if self.sched.get(tid) == (os.SCHED_FIFO | os.SCHED_RESET_ON_FORK, BOOST_PRIORITY):
                    self.sched.set(tid, boost.policy, boost.priority)
                    self.log(f"tid {tid} ran, so it has its own policy {boost.policy} again")
            except OSError:
                pass
        if changed:
            self.save()

    def save(self) -> None:
        if not self.state_file:
            return
        os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
        with open(self.state_file + ".tmp", "w") as f:
            json.dump({str(tid): asdict(boost) for tid, boost in self.boosts.items()}, f)
        os.replace(self.state_file + ".tmp", self.state_file)

    def load(self) -> None:
        """Takes back the boosts a previous run left, so a restart still gives each thread its policy back."""
        try:
            with open(self.state_file) as f:
                self.boosts = {int(tid): Boost(**boost) for tid, boost in json.load(f).items()}
        except (OSError, ValueError, TypeError):
            self.boosts = {}


def set_stall_timeout(path: str = STALL_PARAM, seconds: int = STALL_TIMEOUT_S) -> None:
    with open(path, "w") as f:
        f.write(str(seconds))


def kmsg_reader(path: str = "/dev/kmsg"):
    """next(timeout) gives the text of the next kernel log record written after the start, or None when timeout seconds pass with none."""
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    os.lseek(fd, 0, os.SEEK_END)

    def next_message(timeout: float | None) -> str | None:
        if not select.select([fd], [], [], timeout)[0]:
            return None
        try:
            record = os.read(fd, 8192).decode(errors="replace")
        except OSError as error:
            if error.errno in (errno.EPIPE, errno.EAGAIN):
                return ""
            raise
        return record.split(";", 1)[-1].split("\n", 1)[0]
    return next_message


def serve(booster: Booster, next_message) -> None:
    """Reads kernel records for ever; while a thread is boosted it wakes at least every CHECK_S to settle it."""
    while True:
        message = next_message(CHECK_S if booster.boosts else None)
        if message:
            booster.on_message(message)
        booster.settle()


if __name__ == "__main__":
    set_stall_timeout()
    booster = Booster(Proc(), Sched(), lambda line: print(line, flush=True))
    booster.load()
    booster.settle()
    serve(booster, kmsg_reader())
