"""TLS-time probe for the pre-c165 staging image (dead-try-first-byte-cut-d2). Census crawl() for real handles, each job on a
fresh exit (carry share 1, no parked exits), TLS cap 12 s. Per new connection it records when the CONNECT went out (TCP to the
gateway landed), when the gateway answered CONNECT 200 and when libcurl's pre-request callback ran (TLS done).
Usage: python tls_probe2.py <jobs> <concurrency> <out> <start>"""
import asyncio, json, sys, time
from datetime import UTC, datetime, timedelta
from sirocco.wire.transports import session as ws
from sirocco.sticky import AnswerCaps
from src.platforms.instagram.census import crawl as census_crawl
from src.platforms.instagram.census.upstream import LiveUpstream
from src.platforms.instagram.census.jobs import Job

total, conc, out, start = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
ARMS = [float(x) for x in sys.argv[5].split(",")]
TLS = [ARMS[0]]
handles = json.load(open('/tmp/d2tls/handles.json'))
T0 = time.monotonic()
conns = {}
_tw = ws.tunnel_watch
def tunnel_watch(on_open, on_connect=None):
    inner = _tw(on_open) if on_connect is None else _tw(on_open, on_connect)
    rec = {'out': None, 'open': None, 'ready': None, 'status': None}
    conns[id(rec)] = rec
    def watch(kind, data):
        now = time.monotonic() - T0
        if kind == 2 and data.startswith(b'CONNECT ') and rec['out'] is None:
            rec['out'] = now
        elif kind == 1 and data.startswith(b'HTTP/') and rec['out'] is not None and rec['status'] is None:
            rec['status'] = data[9:12].decode(errors='replace')
            rec['open'] = now
        return inner(kind, data)
    watch._rec = rec
    return watch
LEGS = {}
_sco = ws.session_curl_options
def session_curl_options(*args, **kwargs):
    opts = _sco(*args, **kwargs)
    dbg = opts.get(ws.CurlOpt.DEBUGFUNCTION)
    pre = opts.get(ws.CurlOpt.PREREQFUNCTION)
    if dbg is not None and pre is not None and hasattr(dbg, '_rec'):
        rec = dbg._rec
        LEGS[id(rec)] = 1
        def ready(*a, **k):
            if rec['ready'] is None:
                rec['ready'] = time.monotonic() - T0
            return pre(*a, **k)
        opts[ws.CurlOpt.PREREQFUNCTION] = ready
    return opts
ws.tunnel_watch, ws.session_curl_options = tunnel_watch, session_curl_options

from sirocco.sticky import ExitCarry
def fresh_carry():
    return ExitCarry(max_idle_s=1.0, share=1, answer_caps=lambda: AnswerCaps(tls_s=TLS[0], answer_s=4.5))

async def main():
    up = LiveUpstream()
    sem = asyncio.Semaphore(conc)
    jobs, blocks = [], []
    async def one(i, h, arm, block):
        async with sem:
            now = datetime.now(UTC)
            job = Job(census_id=10**12 + i, lane='new', username=h, ig_id=None, issued_at=now, lease_until=now + timedelta(hours=1))
            carry = census_crawl.CENSUS_CARRY = fresh_carry()
            try:
                obs = await census_crawl.crawl(job, up)
            finally:
                await carry.close()
            jobs.append(dict(job=i, arm=arm, block=block, outcome=str(obs.outcome), ms=obs.elapsed_ms, kinds=[int(k) for k in obs.attempt_kinds], att=list(obs.attempt_ms)))
    per = total // len(ARMS)
    for b, arm in enumerate(ARMS):
        TLS[0] = arm
        t = time.monotonic()
        s = start + b * per
        await asyncio.gather(*(one(i, handles[i], arm, b) for i in range(s, s + per)))
        blocks.append(dict(block=b, arm=arm, s=time.monotonic() - t))
        print('block', b, arm, round(time.monotonic() - t, 1), flush=True)
    json.dump(dict(jobs=jobs, blocks=blocks, conns=list(conns.values())), open(out, 'w'))
    print('done', len(jobs), round(time.monotonic() - T0, 1))

asyncio.run(main())
