---
name: agent-message
description: Message an agent's parent, siblings, or direct children through pi-agent-bus. Discover reachable agents with agent_observe.list_agents, then send direct text without spoofing sender identity.
---

# Agent Message

Send direct messages within the current agent's nuclear family through the
pi-agent-bus extension: parent, siblings, and direct children only. Roots are
siblings. The extension derives your sender identity from the current session;
do not try to include a `from` field.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    receipt = await agent_message.send(
        "Please inspect the latest result.",
        receiver_role="child",
        receiver_name=child.session_name,
    )
    # Keep the child until this follow-up finishes so its result remains observable.
```

## API

- `await agent_observe.list_agents()` (agent-observe skill) is the roster: it
  lists the parent, siblings, and children this skill can reach, active or not,
  with the `relationship` and `sessionName` that `send` takes as
  `receiver_role` and `receiver_name`.
- `await agent_message.send(message, receiver_role="parent" | "sibling" | "child", receiver_name=None, mode=None)` sends one direct
  text message to one family member. Sending to an inactive or idle completed
  subagent wakes it and starts an ordinary follow-up turn in that same session
  and context.
  A closed child or root that pi-rlm or pi-host lists is reopened first. The extension
  resolves `receiver_role` within the current agent family; `receiver_name` is
  required for siblings and children and omitted for the unique parent.
  `send("all", message)` broadcasts only to the family roster and returns
  `{receipts: [...]}` in roster order; successful entries are ordinary receipts
  and failed entries contain the target id and a short `error`. One failed delivery
  does not reject successful deliveries. `mode` is `"auto"` (the default) or
  `"steer"`, which a busy target sees after its current tool batch, or
  `"follow_up"`, which waits until the target's current run ends. An idle target
  starts a new turn in every mode. Returns a receipt with a
  `deliveryStatus` field: `"delivered"` means the message reached an idle target's
  context; `"queued"` means a steering message was accepted and will deliver when
  the target's current work allows (`send` does not block waiting for that).
  Delivered receipts carry `deliveredAt`, queued receipts carry `queuedAt`.

## Safety

- Do not delete a child immediately after `send`: delivered follow-ups may still
  be running and queued receipts have not run yet. Wait until observation shows
  the child is idle and its context is no longer needed before calling
  `await rlm.delete_subagent(child)`.
- Reach is limited to parent, siblings, and direct children; relay through an
  intermediate child instead of messaging grandchildren or cousins directly.
- Sender identity comes from the session and cannot be spoofed from Python.
- Message size (16,384 chars), rate (3 a second per target) and pending queue
  (20 unfinished per target) are soft caps: a send over one goes through, and
  its receipt lists the overrun in `overLimit`.
