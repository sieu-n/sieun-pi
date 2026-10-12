
import os, subprocess, time, sys, re
D = sys.argv[1]; SESS = sys.argv[2]; AUD = sys.argv[3]
LOG = open(SESS + '/part-5-gate.log', 'a', buffering=1)
def free():
    out = subprocess.run(['memory_pressure'], capture_output=True, text=True).stdout.strip().splitlines()[-1]
    return int(re.search(r'(\d+)%', out).group(1))
def ok(): 
    l = os.getloadavg()[0]; f = free(); LOG.write(f'{time.strftime("%H:%M:%S")} load {l:.1f} free {f}%\n'); return l < 20 and f >= 30
def wait_open():
    prev = False
    while True:
        cur = ok()
        if prev and cur: return
        prev = cur
        time.sleep(60)
def run(cmd, out):
    LOG.write(f'{time.strftime("%H:%M:%S")} start {cmd}\n')
    with open(out, 'w') as fh:
        p = subprocess.Popen(cmd, shell=True, cwd=D, stdout=fh, stderr=subprocess.STDOUT, env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=8192'})
        while p.poll() is None:
            time.sleep(10)
            l = os.getloadavg()[0]; f = free()
            if l > 30 or f < 20:
                LOG.write(f'{time.strftime("%H:%M:%S")} ABORT load {l:.1f} free {f}%\n'); p.kill(); p.wait(); return 'aborted'
        LOG.write(f'{time.strftime("%H:%M:%S")} exit {p.returncode}\n'); return p.returncode
wait_open()
r1 = run('pnpm exec vitest run tests/unit/onboarding-walk.test.ts tests/unit/demo-clock.test.ts', SESS + '/part-5-vitest.txt')
wait_open()
r2 = run(f'pnpm exec svelte-check --workspace {D} --tsconfig {AUD} --threshold error --output machine', SESS + '/part-5-svelte-check.txt')
LOG.write(f'DONE vitest={r1} svelte-check={r2}\n')
print('DONE', r1, r2)
