# Create a note

A user saves a titled note from the browser or the CLI, cancels an unfinished draft, and sees the saved note from a second view.

## Sub-features

- `create-open` opens a blank editor from each browser entry point.
- `create-save` stores a title and body.
- `create-cancel` discards an unfinished browser draft.
- `create-cli` creates the same note from the terminal.

## How to get to it (user POV)

- Choose the `New note` button in the browser toolbar.
- Press `n` in the browser while focus is outside a text field.
- Run `notes create --title <title> --body <body>` in a terminal.

## Driving it with control-notes

Before you start, `control-notes doctor` passes and no note is titled `Release checklist`.

1. Run `control-notes browser click --role button --name "New note"`. A form named `Note editor` opens with focus in the `Title` textbox.
2. Run `control-notes browser fill --role textbox --name "Title" --value "Release checklist"` and `control-notes browser fill --role textbox --name "Body" --value "Tag and publish"`. The `Save note` button becomes enabled.
3. Run `control-notes browser click --role button --name "Save note"`. A `Note saved` status appears and the heading reads `Release checklist`.
4. Run `control-notes browser click --role link --name "All notes"`, then `control-notes browser click --role link --name "Release checklist"`. The editor shows both saved values.
5. Run the `New note` click again, `control-notes browser fill --role textbox --name "Title" --value "Discard me"`, and `control-notes browser click --role button --name "Cancel"`. The note list has no `Discard me` link.
6. Run `control-notes cli -- notes create --title "CLI note" --body "Created from terminal" --format json`. The exit code is `0` and stdout has the new note ID and title.
7. From `All notes`, run `control-notes browser snapshot --aria --path artifacts/create-note/list.aria.txt` and `control-notes browser screenshot --path artifacts/create-note/list.png`. Both show `Release checklist` and `CLI note`.

## Gotchas

- Pressing `n` while a textbox has focus types the letter instead of opening an editor.
- The app trims titles on save, so assert the rendered title, not the draft input.
- A `Note saved` status alone does not prove the save, so reopen the note from the list.
- Delete `Release checklist` and `CLI note` during cleanup, and keep their artifacts.
