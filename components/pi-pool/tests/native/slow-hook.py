import os
import sys
import time

marker, mode, hook = sys.argv[1], sys.argv[2], sys.argv[3:]
with open(marker, "a") as runs:
    runs.write("run\n")
with open(marker) as runs:
    first = runs.read().count("run") == 1
if mode == "fail":
    sys.exit(1)
if first:
    time.sleep(13)
os.execv(hook[0], hook)
