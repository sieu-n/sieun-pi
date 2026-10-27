"""The shared slot-park reader for watchdog tests: this checkout's daemon-cli.mjs, with a stub `pi-pool` whose `queue --json` answer the test sets."""
import json
import os
import tempfile
from pathlib import Path

import wd_common

REPO = Path(__file__).resolve().parents[3]
FIXTURE = REPO / 'components/user-history/test/fixtures/slot-park-01a17f25-1028.jsonl'
FIXTURE_ID = '01a17f25-f22d-71ef-9327-e68919164bb4'
NO_POOL = {'enabled': False}


def fixture_lines(upto):
    """The fixture's lines with a timestamp at or before `upto`."""
    rows = FIXTURE.read_text().splitlines()
    return [row for row in rows if json.loads(row)['timestamp'] <= upto]


def use_reader(case, queue=NO_POOL):
    """Point wd_common's daemon reader at this checkout and `pi-pool` at a stub printing `queue`; returns the file that holds the answer."""
    folder = Path(tempfile.mkdtemp())
    answer = folder / 'queue.json'
    answer.write_text(json.dumps(queue))
    stub = folder / 'pi-pool'
    stub.write_text(f'#!/bin/sh\ncat {answer}\n')
    stub.chmod(0o755)
    saved = wd_common.READER_ROOTS, wd_common.ENV.get('PATH', '')
    wd_common.READER_ROOTS = (REPO,)
    wd_common.ENV['PATH'] = f'{folder}{os.pathsep}{saved[1]}'

    def restore():
        wd_common.READER_ROOTS = saved[0]
        wd_common.ENV['PATH'] = saved[1]
    case.addCleanup(restore)
    return answer
