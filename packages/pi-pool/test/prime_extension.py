"""Where Prime's pi-pool extension is: app/extension in an installed release (install.py SHIPS), and
legacy/prime/pi-pool-extension in the checkout, which keeps it apart from the pool until Prime goes."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALLED = ROOT / "app" / "extension" / "index.ts"
EXTENSION = INSTALLED if INSTALLED.exists() else ROOT.parents[1] / "legacy" / "prime" / "pi-pool-extension" / "index.ts"
