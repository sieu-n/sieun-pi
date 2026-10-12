"""Runs the pi-pool CLI with the macOS Keychain replaced by a JSON file
(FAKE_KEYCHAIN), so login tests can check what lands in which store."""
import importlib.util, json, os, sys

SOURCE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vend.py")
spec = importlib.util.spec_from_file_location("vend", SOURCE)
vend = importlib.util.module_from_spec(spec)
sys.modules["vend"] = vend
spec.loader.exec_module(vend)
PATH = os.environ["FAKE_KEYCHAIN"]


def items():
    try:
        with open(PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save(data):
    with open(PATH, "w") as f:
        json.dump(data, f)


vend.kc_read = lambda service: items().get(service)
vend.kc_write = lambda service, secret: save({**items(), service: secret})
vend.kc_delete = lambda service: save({k: v for k, v in items().items() if k != service})
sys.argv = [SOURCE, "--cli", *sys.argv[1:]]
sys.exit(vend.main() or 0)
