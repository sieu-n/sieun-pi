import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from isolation import sitecustomize


GUARD_DIR = Path(__file__).resolve().parent / "isolation"


def isolate_test_module():
    temporary = tempfile.TemporaryDirectory(prefix="pi-pool-isolation-")
    unittest.addModuleCleanup(temporary.cleanup)
    marker = Path(temporary.name) / "violations.jsonl"
    environment = patch.dict(os.environ, {
        "PI_POOL_TEST_ISOLATION_LOG": str(marker),
        "PI_POOL_TEST_ALLOW_LOOPBACK": "0",
        "PYTHONPATH": str(GUARD_DIR),
        "NODE_OPTIONS": "--import " + json.dumps(str(GUARD_DIR.parent / "native/isolation.mjs")),
    })
    environment.start()
    unittest.addModuleCleanup(environment.stop)
    def check():
        if marker.exists():
            raise AssertionError(marker.read_text())
    unittest.addModuleCleanup(check)
