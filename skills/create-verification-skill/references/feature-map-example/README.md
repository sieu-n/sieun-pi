# Notes verification map

Read this index before you drive Notes, then follow the matching feature file.

## Baseline

- Notes runs at `http://127.0.0.1:4173` with a disposable data directory.
- `NOTES_DATA_DIR=/tmp/notes-verify-$RUN_ID` keeps concurrent runs apart.
- The seed data has notes titled `Quarterly plan` and `Grocery list`.
- `control-notes` and the `notes` CLI are on `PATH`.
- `control-notes doctor` must report the expected URL, data directory, and build revision.
- Run browser actions through `control-notes browser` and terminal actions through `control-notes cli -- <command>`.
- Restore the seed data after a change, and keep the proof artifacts.

## Features

- [Create a note](./create-note.md) covers browser and CLI creation, cancel, and persistence.
