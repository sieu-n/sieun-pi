# Prime load-h wire fixtures, 2026-10-27

The six response files are chat-057a's load-x captures from the load.0 dry build, copied unchanged from `/home/sieun/work/prime-load-fixes/x/fixtures/`.
Rig paths read `<rig>`, the fake provider port reads `<port>`, and prompt texts read `<prompt-text>`.
`list-row-mixed-crc2-supervisor.json` holds the fields that the rig recorded for the busy list row in its new-then-old run, where a crc.2 supervisor adopted load.0 workers.
That row carries `queuedLanes.steering` 1 while the old supervisor sets `sessionActions.queuedCount` to 0.
