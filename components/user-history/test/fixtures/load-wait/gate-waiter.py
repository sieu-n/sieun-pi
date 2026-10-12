
import os, subprocess, time, sys
ok=0
for i in range(200):
    l=os.getloadavg()[0]
    out=subprocess.run(['memory_pressure'],capture_output=True,text=True).stdout.strip().splitlines()[-1]
    free=int(out.split(':')[-1].strip().rstrip('%'))
    print(time.strftime('%H:%M:%S'), l, free, flush=True)
    if l<20 and free>=30:
        ok+=1
        if ok>=2: print('GATE_OPEN'); sys.exit(0)
        time.sleep(60); continue
    ok=0
    time.sleep(360)
print('GATE_TIMEOUT')
