"""dhx.3 Prime with the p692 hook on us-metal02, 10-20: a turn pi-pool holds ends on Prime's credential wait marker (stopReason "error").
fleet_health read it as FAULT, so a pass in a pool drought reported every waiting session as broken."""
import json, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills"))
from skills.prime_agent import fleet_health  # noqa: E402

SID = "01a15a2b-be18-7478-8fd1-ec1fc833dec4"
MARKER = {"type": "message", "timestamp": "2026-10-20T17:30:08.140Z", "message": {
    "role": "assistant", "content": [], "provider": "anthropic", "model": "claude-opus-5-5", "stopReason": "error",
    "errorMessage": "API key for provider \"anthropic\" is temporarily unavailable until 2026-10-20T17:32:00.000Z: waiting for an account slot",
    "diagnostics": [{"type": "provider_stream_failure", "details": {"kind": "credential_unavailable", "retryAtMs": 1792517520000, "retryAfterMs": 111860}}]}}


class MarkerHealth(unittest.TestCase):
    def verdict(self, last):
        f = Path(tempfile.mkdtemp()) / f"{SID}.jsonl"
        f.write_text(json.dumps({"type": "message", "timestamp": "2026-10-20T17:30:07.900Z", "message": {"role": "user", "content": "brief"}}) + "\n"
                     + json.dumps(last) + "\n")
        sessions = {SID: {"sessionId": SID, "id": "ec1fc833dec4", "sessionFile": str(f), "activity": "idle"}}
        return fleet_health.classify(SID, sessions)

    def test_a_credential_wait_marker_reads_as_a_wait(self):
        row = self.verdict(MARKER)
        self.assertEqual((row["verdict"], row["detail"]), ("POOL_WAIT", "waits for its pi-pool slot until 2026-10-20T17:32:00+00:00"))

    def test_a_connection_error_is_still_a_fault(self):
        failed = {**MARKER, "message": {**MARKER["message"], "errorMessage": "Connection error.", "diagnostics": []}}
        self.assertEqual(self.verdict(failed)["verdict"], "FAULT")


if __name__ == "__main__":
    unittest.main()
