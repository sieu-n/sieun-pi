# The spec page and optional mock

The issue keeps the explanation the owner needs, and the spec page holds the detail.
When the target repo has its own wiki or page rules, follow that repo's skill for the page location and format.

## Page content

- Start with the outcome and who the change affects.
- Add the approach, before-and-after examples, tradeoffs, and success conditions when they help.
- Choose sections for the subject.
- Pass code pointers, edit order, commands, and debugging notes as `agent_notes`, which `build_page()` puts in a collapsed `<details>` block.

## Diagrams and screenshots

- Show important states and choices, and skip decorative diagrams.
- Pass the Mermaid sources to `build_page()` as `mermaid=[...]`, where `mermaid[N-1]` replaces the image `assets/diagrams/dN.png`.
- Put screenshots in `assets/mock/<state>.png` or another folder under `assets/`.
- For observed behavior, state where and when you saw it.

## When a mock helps

Build a mock when the owner needs to compare an interaction or a proposed screen.
For API work, a rendered OpenAPI example can show the request and the result.

- Use the target app's components and styles with synthetic data and no network calls.
- Check the target project's production exclusion rules before you add a mock route.
- Leave mocks uncommitted unless asked.
- Test the interaction and capture screenshots through the `aside-browser` skill.
- An HTTP 200 does not prove that the screen or interaction works.

## Parallel ticket writers

When several workers write tickets, the parent owns every screenshot and diagram capture, because the Aside REPL shares one page.
Workers write the ticket, the spec page, any mock, and the state descriptions.
The parent captures images, calls `linear_ticket.check()`, pushes, and reads the issue back.
