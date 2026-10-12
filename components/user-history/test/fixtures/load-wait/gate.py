import os, re, subprocess, time, sys
def reading():
    l = os.getloadavg()[0]
    out = subprocess.run(['memory_pressure'], capture_output=True, text=True).stdout
    m = re.search(r'free percentage: (\d+)%', out)
    return l, int(m.group(1)) if m else 0
ok_prev = False
while True:
    l, f = reading()
    ok = l < 20 and f >= 30
    print(time.strftime('%H:%M:%S'), f'load {l:.1f} free {f}%', 'ok' if ok else 'wait', flush=True)
    if ok and ok_prev:
        print('GATE OPEN', flush=True); sys.exit(0)
    ok_prev = ok
    time.sleep(60)
