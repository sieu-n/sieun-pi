import sys
import urllib.request

with urllib.request.urlopen(sys.argv[1], timeout=8) as response:
    token = response.read().decode()
    with open(sys.argv[2], "a") as marker:
        marker.write("completed\n")
    sys.stdout.write(token)
