import json
import pathlib
import sys

print(json.loads((pathlib.Path(sys.argv[1]) / "control.json").read_text())["keyLabel"])
