import os, subprocess, time, re
def ok():
    l = os.getloadavg()[0]
    out = subprocess.run(['memory_pressure'], capture_output=True, text=True).stdout
    m = re.search(r'free percentage: (\d+)%', out)
    f = int(m.group(1)) if m else 0
    print(time.strftime('%H:%M:%S'), 'load', round(l,1), 'free', f, flush=True)
    return l < 20 and f >= 30
prev = False
while True:
    cur = ok()
    if cur and prev:
        print('GATE OPEN', flush=True); break
    prev = cur
    time.sleep(60)
