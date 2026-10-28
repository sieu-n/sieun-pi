/*
 * An ask that has the owner pick a 5180 screen's layout or design from words (c124). The owner, 10-19: "얼라인이 맞는지 보는 제일 쉬운 방법이
 * 5180 frontend 보는거니까". On 10-28 frontend bro still had a job put three Swipe layouts on a wiki page, then asked "Which Swipe layout, A where
 * the card is their profile page with a post grid (my pick), B with an up-next list on the left, or C with posts first?" in tell_owner and in
 * t51, and "How should the full-screen New campaign be laid out?" in t49, with no 5180 link. He answered "siwpe layout, 직접 만들어보라니까
 * 이런건?". tell_owner refuses such a text once and the board flags such a todo; both let it through when sent again (c98).
 */

/** Words that name a screen's arrangement. A bare "design" is left out, since a sync or schema design goes on a wiki page (c14). */
const LAYOUT = /\b(?:layouts?|laid\s+out|lay\s+(?:it\s+)?out|wireframes?|mock-?ups?|(?:ui|screen|page|card|visual)\s+(?:designs?|redesigns?))\b|레이아웃|화면\s*구성|시안/iu;
/** Words that ask him to choose between options: a pick, a "which ...?" question, or lettered options like "A ..., B ... or C". */
const PICK = /\b(?:pick|choose|prefer|option\s+[a-c1-3])\b|\bwhich\b[^.?!]{0,60}\?|골라|선택|어떤/iu;
const LETTERED = /\b[A-C]\b[^?!]{0,200}\bor\s+[A-C]\b/u;
/** A link that opens the options on 5180: a demo URL (localhost or the box's 15180 copy) or a variant switch like `?v.creators=swipe-a`. */
const SCREEN_LINK = /:1?5180\b|\bv\.[a-z][\w-]*=/iu;
/** An owner message that asks for a page or document, after which options in words are what he asked for. */
const ASKS_PAGE = /\b(?:page|doc|docs|document|write-?up|wiki|in\s+words|text)\b|문서|페이지|위키|정리해/iu;

/** The words that ask the owner to pick a layout, or null: a layout word, a pick (or two or more choices), and no 5180 link. */
export function layoutPickInWords(text: string, choices: readonly string[] = [], links: readonly string[] = []): string | null {
  const all = [text, ...choices].join("\n");
  if (SCREEN_LINK.test([all, ...links].join(" "))) return null;
  const layout = LAYOUT.exec(all);
  if (!layout) return null;
  return choices.length >= 2 || PICK.test(all) || LETTERED.test(all) ? layout[0] : null;
}

/** Whether the owner's message asked for a page or a document, so a layout described in words is his ask. */
export const ownerAskedForPage = (ownerText: string | undefined): boolean => ASKS_PAGE.test(ownerText ?? "");

export const LAYOUT_WORDS_FIX = "He picks layouts and designs on the 5180 screens, not from words (c124). Start one builder per option, each " +
  "forking the current line into a variant with a plain title, then send each localhost:5180 link with its ?v.<app>=<variant> and one shot you " +
  "opened, and he picks in the version picker";
