"""A pool with one Codex account in which one session tree waits for its slot until a given time and any other
tree is served. The waiting tree is low priority and holds an R5 backoff on the account, whose 5h window reads 60%
until that time: over the 50% a low tree enters under, under the 70% a normal tree enters under. No network: the
token is a fake JWT good for 30 days, and the window's sample is dated ahead so no usage read starts."""
import base64, json, os, time

ACCOUNT = "cccc3333-0000-0000-0000-000000000000"


def jwt(claims):
    part = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return part({"alg": "none"}) + "." + part(claims) + ".fixture"


def make_waiting_pool(path, waiting_tree, until):
    """The pool at `path`, with `waiting_tree` waiting until `until` (epoch seconds). Returns the account's token."""
    now = time.time()
    os.makedirs(os.path.join(path, "accounts", "openai-codex"), exist_ok=True)
    window = {"windowSeconds": 5 * 3600, "usedPercentage": 60, "resetsAt": int(until * 1000),
              "sampledAt": int((now + 86400) * 1000)}
    with open(os.path.join(path, "accounts", "openai-codex.json"), "w") as f:
        json.dump({"version": 1, "accounts": [{"id": ACCOUNT, "email": "c@x", "label": "c@x", "tier": "plus",
                                                "windows": [window]}]}, f)
    token = jwt({"exp": int(now) + 30 * 86400, "https://api.openai.com/auth": {"chatgpt_account_id": ACCOUNT}})
    with open(os.path.join(path, "accounts", "openai-codex", ACCOUNT + ".json"), "w") as f:
        json.dump({"tokens": {"access_token": token, "refresh_token": "fixture-refresh"}}, f)
    wait = {"account": ACCOUNT, "slot_at": until, "since": now, "backoff": True}
    with open(os.path.join(path, "state.json"), "w") as f:
        json.dump({"version": 2, "sessions": {waiting_tree: {
            "uuid": None, "active_id": waiting_tree, "pins": {}, "last_seen": now, "priority": "low",
            "wait": {"openai-codex": wait}}}}, f)
    return token
