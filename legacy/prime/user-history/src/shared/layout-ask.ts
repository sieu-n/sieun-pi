/*
 * The owner reviews UI and product work on the 5180 screens, never in design documents (c124). The owner, 10-19: "얼라인이 맞는지 보는 제일 쉬운
 * 방법이 5180 frontend 보는거니까", after the chat sent him the Campaigns final plan page while its fork already rendered. On 10-28 frontend bro
 * still had a job put three Swipe layouts on a wiki page, then asked "Which Swipe layout, A ..., B ... or C ...?" in tell_owner and in t51,
 * and he answered "siwpe layout, 직접 만들어보라니까 이런건?". This file reads the three shapes of that miss: a layout or design pick in words
 * (`layoutPickInWords`), a design or plan page for a screen handed to him in place of the screen (`designPageForScreens`), and a brief or plan
 * step that has a job write such a page (`screenOptionsOnPage`). tell_owner refuses the first two once, the board flags all of them on a todo
 * or step, and the brief check steers the chat on the third; each lets the same text through when sent again (c98).
 */

/** Words that name a screen's arrangement. A bare "design" is left out, since a sync or schema design goes on a wiki page (c14). */
const LAYOUT = /\b(?:layouts?|laid\s+out|lay\s+(?:it\s+)?out|wireframes?|mock-?ups?|(?:ui|screen|page|card|visual)\s+(?:designs?|redesigns?))\b|레이아웃|화면\s*구성|시안/iu;
/** A 5180 screen or app by the name the owner uses. Generic words like campaign, creators, row or column also name data, so they are left out. */
const SCREEN = /\b(?:screens?(?!\s+shar)|5180|swipe|watchlist|inbox|dashboards?|onboarding|new\s+campaign|outreach\s+templates|scout|deck|sidebar)\b|화면|온보딩|스와이프|인박스|대시보드/iu;
/** What else a layout word may be about on a screen. "Layout" alone also names a disk or a table, as in "Where should Kafka live in your a/b/c layout?". */
const UI_PART = /\b(?:pages?|apps?|ui|cards?|views?|tabs?|panels?|menus?|forms?|lists?|designs?|navigation|nav)\b/iu;
/** Ways to arrange a screen that a pick between options names, such as cards or a table, two columns, a wizard, posts first. */
const ARRANGEMENT = /\b(?:cards\s+or\b|or\s+cards|as\s+cards|card\s+(?:view|grid)|(?:a|the)\s+table(?:\s+view)?|table\s+view|grid(?![-\w])|(?:two|three|2|3)[\s-]+(?:columns?|panes?)|split\s+view|side\s+panel|list\s+view|one\s+(?:long\s+)?page|wizard|progress\s+bar|carousel|[a-z]+-first|(?:posts|profile)\s+first|directions)\b|[A-C]안|한\s*페이지|단계별/iu;
/** Words that ask him to choose between options: a pick, a "which ...?" question, or lettered options like "A ..., B ... or C". */
const PICK = /\b(?:pick|choose|prefer|option\s+[a-c1-3])\b|\bwhich\b[^.?!]{0,60}\?|골라|선택|어떤|중에/iu;
const LETTERED = /\b[A-C]\b[^?!]{0,200}\bor\s+[A-C]\b/u;
/** A question that offers two ways: "X or Y?". */
const EITHER = /\bor\b[^.?!]{0,80}\?/iu;
/** A link that opens the options on 5180: a demo URL (localhost or the box's 15180 copy) or a variant switch like `?v.creators=swipe-a`. */
const SCREEN_LINK = /:1?5180\b|\bv\.[a-z][\w-]*=/iu;
/**
 * An owner message that asks for a page or document: a write, make or send verb before page, doc or write-up, or a doc word on its own. A bare
 * "page" is his word for a screen ("the swipe page needs work"), so it counts only after such a verb.
 */
const ASKS_PAGE = /\b(?:write|make|draft|put|send|give)\b[^.?!]{0,50}\b(?:page|doc|docs|document|write-?up|wiki)\b|\bwrite[\s-]?up\b|\bin\s+words\b|\bas\s+text\b|문서|위키|정리해/iu;
/** A page or document the text hands over or names: a wiki link, a wiki page URL, or a doc word. A bare "page" can be a screen, so it needs "wiki". */
const PAGE = /\bwiki:|:5176\/page\/|\bwiki\s+page\b|\b(?:design|decision|plan|options?|redesign)\s+(?:page|doc)\b|\b(?:doc|docs|document|write-?up)\b|문서|위키/iu;
/** What makes a page a design for a screen: a redesign, options or directions, layouts, wireframes or mockups. */
const DESIGN = /\b(?:redesigns?|options?|directions?|layouts?|wireframes?|mock-?ups?|html\s+mocks?|alternatives?)\b|시안|[A-C]안/iu;
/** A plan, design or spec, which is a design for a screen only when the text names a screen itself: "the sync design" is not. */
const PLAN = /\b(?:plan|design|spec|decision)\b/iu;
const SCREEN_ITSELF = /\b(?:screens?|5180|frontend|ui)\b|화면/iu;
/** Screenshots, which show him the screens themselves: "5174 got the data details, not the full 5180 design. [Screenshots and findings](wiki:...)". */
const SHOTS = /\b(?:screenshots?|shots?)\b|!\[/iu;
/** A link target, whose path words ("5180-product-plan", "design.html") are not what the message says. */
const LINK = /\bwiki:\S+|https?:\/\/\S+/giu;
/** Words of a brief or step that build the options as screens: a variant fork or switch, 5180 variants, a 5180 link or one builder per option. */
const BUILDS = /variant:fork|\bfork\b|\bv\.[a-z][\w-]*=|:1?5180\b|\b5180\s+variants?\b|\bswitchable\b|\bone\s+builder\s+per\b|\bbuild\s+(?:each|every|all)\b/iu;

/** The words that ask the owner to pick a layout, or null: a layout (or a screen and a way to arrange it), a pick or choices, and no 5180 link. */
export function layoutPickInWords(text: string, choices: readonly string[] = [], links: readonly string[] = []): string | null {
  const all = [text, ...choices].join("\n");
  if (SCREEN_LINK.test([all, ...links].join(" "))) return null;
  const pick = choices.length >= 2 || PICK.test(all) || LETTERED.test(all);
  const layout = LAYOUT.exec(all);
  if (layout && (SCREEN.test(all) || UI_PART.test(all))) return pick ? layout[0] : null;
  const arranged = ARRANGEMENT.exec(all);
  // The arrangement word itself, such as "cards", is no proof of a screen, so the screen word is looked for in the rest of the text.
  const rest = arranged ? all.replace(arranged[0], " ") : "";
  return arranged && (SCREEN.test(rest) || UI_PART.test(rest)) && (pick || EITHER.test(all)) ? arranged[0] : null;
}

/**
 * The words of a text that hands the owner a design or plan page for a 5180 screen with no 5180 link, or null: a page (`PAGE`), and either
 * options for a screen (`DESIGN` with `SCREEN`) or a plan or design that names screens (`PLAN` with `SCREEN_ITSELF`), read without link paths. On 10-19 the chat sent "The Campaigns final plan is up, with ... every
 * screen's data source ... wiki:sessions/2026/10/19/1732-campaigns-final/decision" while its fork already rendered with ?v.creators=campaigns-final.
 */
export function designPageForScreens(text: string, links: readonly string[] = []): string | null {
  const all = [text, ...links].join("\n");
  if (SCREEN_LINK.test(all) || !PAGE.test(all) || SHOTS.test(all)) return null;
  const said = text.replace(LINK, " ");
  const design = DESIGN.exec(said);
  if (design) return SCREEN.test(said) || LAYOUT.test(said) || SCREEN_ITSELF.test(said) ? design[0] : null;
  const plan = PLAN.exec(said);
  return plan && SCREEN_ITSELF.test(said) ? plan[0] : null;
}

/**
 * The words of a job brief's task or a plan step that has a job put options for a 5180 screen on a page instead of building them, or null: a
 * page, options, directions, layouts, wireframes or mockups, a screen, and nothing that builds them as variants (`BUILDS`). The 10-28 brief
 * asked for one wiki page with "Two or three redesign options, each with a one-line pitch, a small wireframe" and "Do not change app code".
 */
export function screenOptionsOnPage(text: string): string | null {
  if (BUILDS.test(text) || !PAGE.test(text)) return null;
  const options = /\b(?:(?:redesign|layout|design)\s+)?(?:options|directions|alternatives|layouts|wireframes?|mock-?ups?|html\s+mocks?)\b|[A-C]안/iu.exec(text);
  return options && (SCREEN.test(text) || LAYOUT.test(text)) ? options[0] : null;
}

/** Whether the owner's message asked for a page or a document, so a layout described in words is his ask. */
export const ownerAskedForPage = (ownerText: string | undefined): boolean => ASKS_PAGE.test(ownerText ?? "");

export const LAYOUT_WORDS_FIX = "He picks layouts and designs on the 5180 screens, not from words (c124). Start one builder per option, each " +
  "forking the current line into a variant with a plain title, then send each localhost:5180 link with its ?v.<app>=<variant> and one shot you " +
  "opened, and he picks in the version picker";

export const DESIGN_PAGE_FIX = "He reviews UI and product work on the 5180 screens, not on a page (c124). Send the localhost:5180 link with its " +
  "?v.<app>=<variant> and one shot you opened as soon as the screens render; if none render yet, have a job build them and send the link when they " +
  "do. A page for the builders stays with them";
