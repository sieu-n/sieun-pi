import type { OlderPage, ThreadState } from "../shared/types.ts";

/** An older page put in front of the held messages, with the cursor for the page before it. */
export function prependOlder(state: ThreadState, page: OlderPage): ThreadState {
  return withOlder({ ...state, messages: [...page.messages, ...state.messages] }, page.older);
}

function withOlder(state: ThreadState, older: string | undefined): ThreadState {
  const { older: _dropped, ...rest } = state;
  return older === undefined ? rest : { ...rest, older };
}
