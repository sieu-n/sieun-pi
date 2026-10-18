import json
import pathlib
import sys
import base64

root = pathlib.Path(sys.argv[1])
state = json.loads((root / "control.json").read_text())
fail = state.get("alwaysFail", False) or state.get("failNext", 0) > 0
if state.get("failNext", 0) > 0:
    state["failNext"] -= 1
    (root / "control.json").write_text(json.dumps(state))
with (root / "hook.jsonl").open("a") as log:
    log.write(json.dumps({"failed": fail, "keyLabel": state["keyLabel"]}) + "\n")
if fail:
    sys.exit(9)
payload = {"https://api.openai.com/auth": {"chatgpt_account_id": "synthetic-fixture-only"}, "fixture": state["keyLabel"]}
encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
print("eyJhbGciOiJub25lIn0." + encoded + ".synthetic")
