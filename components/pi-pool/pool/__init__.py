"""pi-pool's code. vend.py loads this package from its own real folder (load_pool).

The token hook runs on every provider request, so the package loads only the modules
the vend path needs. Every other module loads on its first use as an attribute of this
package, from this package's folder, even when sys.modules names another load of vend.py."""
import importlib.util, os, sys

from . import base, registry, sched, vending, remote

LAZY = ("status_view", "commands", "limit_resets", "signin", "session_cmds", "turns", "usage", "hookd", "snapshot")
PACKAGE = sys.modules[__name__]


def __getattr__(name):
    if name not in LAZY:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    full = f"{__name__}.{name}"
    shown = {key: sys.modules.get(key) for key in (__name__, full)}
    sys.modules[__name__] = PACKAGE
    try:
        spec = importlib.util.spec_from_file_location(full, os.path.join(__path__[0], name + ".py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[full] = module
        spec.loader.exec_module(module)
        setattr(PACKAGE, name, module)
        shown[full] = module
        return module
    finally:
        for key, module in shown.items():
            if module is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = module
