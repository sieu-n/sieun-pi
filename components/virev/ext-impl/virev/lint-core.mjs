/**
 * Mechanical unslop linter — TypeScript port of /tmp/pstack-audit/ext-unslop/lint.py.
 *
 * Parity contract (see lint-parity.md):
 *  - Same rule names, same masking pipeline, same ordering, same 70/60-char truncation.
 *  - `pos` is a CODE POINT index (Python `str` convention), not a UTF-16 code unit index.
 *  - Python `\w`, `\d`, `\s`, `\b` are Unicode-aware; JS `\w`/`\b`/`\d` are ASCII-only, so every
 *    such class is expanded below into an explicit Unicode class used with the `u` flag.
 *
 * No imports, no npm deps. Nothing runs at module load except const and regex
 * definitions; the self test is `selfTest()`.
 *
 * This .mjs is the source. It was produced once from the reviewed TypeScript port
 * with the repo's own tsc (--removeComments false); edit this file directly.
 */
const MASK = "\u0000";
/* ---------------------------------------------------------------- character classes */
/* Python str-pattern `\w` == alnum (Unicode) + "_". JS `\w` is ASCII-only, so spell it out. */
const W = "0-9A-Za-z_\\p{L}\\p{N}";
/* Python `\b`. JS `\b` uses the ASCII word class, so emulate with lookaround on W. */
const B = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
/* Python str-pattern `\d` == Unicode decimal digits. */
const D = "\\p{Nd}";
/* Python str-pattern `\s`, verified code point for code point against CPython. */
const S = " \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SC = `[${S}]`;
const NOT_S = `[^${S}]`;
/* Python `^`/`$` under re.M: line breaks are "\n" only. JS `m` also breaks on \r/\u2028/\u2029. */
const BOL_M = "(?<![^\\n])";
const EOL_M = "(?![^\\n])";
/* Python `$` without re.M: end of string, or just before one trailing "\n". */
const EOS = "(?=\\n?(?![\\s\\S]))";
/* ---------------------------------------------------------------- regex helpers */
function re(pattern, flags) {
    return new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
}
/** Next code point index after `i` (Python advances empty matches by one code point). */
function stepOver(s, i) {
    const cp = s.codePointAt(i);
    return i + (cp !== undefined && cp > 0xffff ? 2 : 1);
}
/**
 * Python `pat.finditer(s)`: leftmost matches, empty matches advance by one code point.
 * The regex is cloned so a shared /g/ object never leaks `lastIndex` between calls.
 */
function findAll(pat, s) {
    const rx = new RegExp(pat.source, pat.flags);
    const out = [];
    let pos = 0;
    while (pos <= s.length) {
        rx.lastIndex = pos;
        const m = rx.exec(s);
        if (m === null)
            break;
        out.push(m);
        pos = m[0].length === 0 ? stepOver(s, m.index) : m.index + m[0].length;
    }
    return out;
}
/* ---------------------------------------------------------------- code point <-> UTF-16 */
/** Map each UTF-16 index -> code point index; length is s.length + 1. */
function cpIndexMap(s) {
    const map = new Array(s.length + 1);
    let cp = 0;
    for (let i = 0; i < s.length; i++) {
        map[i] = cp;
        const c = s.codePointAt(i);
        if (c !== undefined && c > 0xffff) {
            i++;
            map[i] = cp;
        }
        cp++;
    }
    map[s.length] = cp;
    return map;
}
/** Python `s[a:b]` (code points). */
function cpSlice(s, a, b) {
    return Array.from(s).slice(a, b).join("");
}
/** Python `len(s)` (code points). */
function cpLen(s) {
    return Array.from(s).length;
}
/* ---------------------------------------------------------------- masking */
const MASK_PATTERNS = [
    /* fence */ re("```[\\s\\S]*?```", "gu"),
    /* fence_open */ re("```[^`]*" + EOS, "gu"),
    /* inline */ re("`[^`\\n]+`", "gu"),
    /* blockquote */ re(BOL_M + "[ \\t]*>[^\\n]*" + EOL_M, "gu"),
    /* table */ re(BOL_M + "[ \\t]*\\|[^\\n]*\\|[ \\t]*" + EOL_M, "gu"),
    /* url */ re(`https?://${NOT_S}+`, "gu"),
    /* path */ re(`(?<![${W}/])(?:~|\\.{1,2})?/[${W}.\\-/@]+` +
        `|(?<![${W}.])[${W}\\-.]+\\.(?:mjs|js|ts|py|md|json|jsonl|sh|svelte|toml|yaml|yml|sql|csv|tsx)${B}`, "gu"),
    /* ident */ re(`${B}[${W}]+_[${W}]+${B}`, "gu"),
    /* num_range */ re(`[${D}]+${SC}*[\\u2013]${SC}*[${D}]+`, "gu"),
];
function stripMask(s) {
    return s.split(MASK).join("");
}
/* ---------------------------------------------------------------- rule tables */
const BOLD = re("\\*\\*([\\s\\S]+?)\\*\\*", "gu");
const QUOTE = re('"[^"\\n]{1,200}"', "gu");
const PARA_STARTS = re(`(?:^|\\n)[ \\t]*(?:[-*+]${SC}+|[${D}]+\\.${SC}+)?`, "gu");
const HARD = [
    ["1 em dash", re(`[\\u2014]|(?<=[${W}]) [-\\u2013]{1,2} (?=[${W}])|(?<=[${W}])--(?=[${W}])`, "gu")],
    ["6 emoji", re("[\\u{1F300}-\\u{1FAFF}\\u2705\\u274C\\u2728\\u26A0\\u2714\\u2717\\uFE0F]", "gu")],
    ["7 curly quote", re("[\\u2018\\u2019\\u201C\\u201D]", "gu")],
    [
        "8 italics",
        re(`(?<![${W}*])\\*([^*\\n]{1,80})\\*(?![${W}*])|(?<![${W}_])_([^_\\n]{1,80})_(?![${W}_])`, "gu"),
    ],
    [
        "10 announcing honesty",
        re(`${B}(the honest (answer|framing|version|truth)|to be honest|honestly[,${S}]` +
            `|stated with its limits|the uncomfortable (part|truth)|answered honestly)`, "giu"),
    ],
    [
        "15 fancy word",
        re(`${B}(delve|foster|leverage|utilize|facilitate|empower|streamline|robust|cutting-edge` +
            `|paradigm|tapestry|realm|beacon|multifaceted|meticulous|intricate|paramount` +
            `|transformative|elevate|embark|supercharge|ever-evolving|seamless|comprehensive` +
            `|pivotal|holistic|myriad|additionally|crucial|enhance|enduring|garner|interplay` +
            `|showcase|testament|underscore|vibrant|commence|remediate|methodology)[${W}]*${B}`, "giu"),
    ],
    ["16 marketing word", re(`${B}(easy|easily|simple|simply|quick|quickly|powerful)${B}`, "giu")],
    [
        "27 puffery",
        re("plays a (vital|key|critical) role|marks a pivotal|underscores|a testament to" +
            "|setting the stage for", "giu"),
    ],
    [
        "30 meta-narration",
        re("this section (describes|covers)|as mentioned|worth noting|it is important to note" +
            "|let'?s (look at|dive|explore)|in other words|now that we'?ve", "giu"),
    ],
    ["37 filler", re("in order to|due to the fact that|for the purpose of|in the event that", "giu")],
    [
        "39 chatbot",
        re("I hope this helps|let me know if|of course[,!]|certainly[,!]|great question" +
            "|you'?re absolutely right|smoking gun", "giu"),
    ],
    [
        "43 metaphor noun",
        re(`${B}(substrate|wedge in|vector|locus|vantage|nexus|primitive|bedrock|scaffolding` +
            `|modality|gold-plating|ratchet|evacuate|endgame|north star|flywheel)${B}` +
            `|${B}(?:API|attack|design) surface${B}`, "giu"),
    ],
    [
        "12 hollow superlative",
        re("the (most|single most) (valuable|durable|important|useful|striking)" +
            "|the right call|the sharpest|earned (its|their) (way|place)" +
            "|the (biggest|cleanest|best) (win|finding|part)" +
            "|the one thing I would", "giu"),
    ],
    [
        "21 weak verb",
        re(`${B}(serves as|stands as|boasts|has the ability to|made (a|the) decision` +
            `|is configurable|provides for)${B}`, "giu"),
    ],
    [
        "29 faux insight",
        re("here'?s the thing|what most people miss|the (real )?truth is|the thing is" +
            "|what nobody tells you", "giu"),
    ],
    [
        "31 superficial -ing clause",
        re(`,${SC}+(ensuring|highlighting|showcasing|demonstrating|underscoring|reflecting)${SC}`, "giu"),
    ],
    [
        "32 weasel attribution",
        re("studies show|experts (believe|say|agree)|industry reports suggest" +
            "|widely (regarded|believed|considered)|it is (widely|generally) (known|accepted)", "giu"),
    ],
    [
        "38 excessive hedging",
        re("could potentially|may possibly|might potentially|it could be argued" +
            "|there is a possibility that|it may be that", "giu"),
    ],
    [
        "40 cutoff disclaimer",
        re("while specific details are limited|as of my (last|knowledge)" +
            "|I do not have access to real-?time|without more (context|information), it", "giu"),
    ],
    [
        "41 generic conclusion",
        re("the future looks bright|only time will tell|the possibilities are endless" +
            "|remains to be seen|in conclusion,", "giu"),
    ],
];
const HEUR = [
    ["2 mid-sentence colon", re(`(?<=[${W}]):${SC}`, "gu")],
    /* rule 4: a bold label that restates the line, `**Runbook:** the runbook now ...` */
    ["4 bold label colon", re("\\*\\*[^*\\n]{1,40}:\\*\\*", "gu")],
    [
        "17 empty qualifier",
        re(`${B}(very|just|really|actually|essentially|exactly|arguably|significantly` +
            `|typically|generally|fundamentally|importantly|strictly)${B}`, "giu"),
    ],
    [
        "28 binary contrast",
        re(`${B}not (?:just |only |merely )?(?:an?|the )?[${W}' \\-]{1,35}, but(?: also)? ` +
            `|${B}it'?s not [^,.]{1,40}, it'?s `, "giu"),
    ],
];
/* rule 19: repo, vendor and API verbs beat the banned lists */
const EXEMPT = new RegExp(`${B}(terminate[sd]?|terminating|instance termination|robustness)${B}`, "iu");
/* Python `re.match(r"\s*(?:[-*+]\s|\d+\.\s)", after)` — anchored at index 0. */
const COLON_LIST_AHEAD = new RegExp(`^${SC}*(?:[-*+]${SC}|[${D}]+\\.${SC})`, "u");
/* Python str.rstrip() strips Unicode whitespace. */
const TRAILING_WS = new RegExp(`${SC}+$`, "u");
function prepare(raw) {
    const rawCps = Array.from(raw);
    const rawMap = cpIndexMap(raw);
    const masked = new Array(rawCps.length).fill(false);
    for (const pat of MASK_PATTERNS) {
        for (const m of findAll(pat, raw)) {
            const a = rawMap[m.index];
            const b = rawMap[m.index + m[0].length];
            for (let i = a; i < b; i++)
                masked[i] = true;
        }
    }
    const tCps = rawCps.map((c, i) => (masked[i] ? MASK : c));
    const t = tCps.join("");
    const quoteRanges = findAll(QUOTE, raw).map((m) => [rawMap[m.index], rawMap[m.index + m[0].length]]);
    return { t, tCps, tMap: cpIndexMap(t), quoteRanges };
}
function inQuoteAt(ranges, pos) {
    for (const [a, b] of ranges)
        if (a <= pos && pos < b)
            return true;
    return false;
}
function boldHits(m) {
    const starts = new Set();
    for (const ps of findAll(PARA_STARTS, m.t)) {
        starts.add(m.tMap[ps.index + ps[0].length]);
    }
    const out = [];
    for (const b of findAll(BOLD, m.t)) {
        const g = b[1];
        const vis = stripMask(g);
        const visLen = cpLen(vis);
        if (visLen <= 40)
            continue; /* rule 3 length budget */
        if (visLen < 0.5 * cpLen(g))
            continue; /* mostly code or a path, not emphasis */
        const startCp = m.tMap[b.index];
        if (starts.has(startCp) && vis.replace(TRAILING_WS, "").endsWith(".")) {
            continue; /* rule 4 lead-in exemption */
        }
        out.push([startCp, cpSlice(vis, 0, 70)]);
    }
    return out;
}

/* Rule 5: a markdown heading in Title Case. Three or more capitalised words with
 * no sentence-ending punctuation is the shape; acronyms and code are masked out
 * before this runs, so CI and ClickHouse do not count. */
const HEADING = re(BOL_M + "[ \\t]*#{1,6}[ \\t]+([^\\n]+)" + EOL_M, "gu");
function headingHits(m) {
    const out = [];
    for (const h of findAll(HEADING, m.t)) {
        const text = stripMask(h[1]).trim();
        const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
        if (words.length < 3)
            continue;
        const capped = words.filter((w, i) => i > 0 && /^[A-Z][a-z]/.test(w));
        if (capped.length >= 2 && capped.length >= words.length - 2) {
            out.push([m.tMap[h.index], cpSlice(text, 0, 70)]);
        }
    }
    return out;
}
export function lintText(raw) {
    const m = prepare(raw);
    const hits = [];
    for (const [name, pat] of HARD) {
        for (const hit of findAll(pat, m.t)) {
            const frag = hit[0];
            if (name === "15 fancy word" && EXEMPT.test(frag))
                continue;
            const pos = m.tMap[hit.index];
            hits.push({
                kind: "hard",
                rule: name,
                pos,
                frag: cpSlice(frag, 0, 70),
                inQuote: inQuoteAt(m.quoteRanges, pos),
            });
        }
    }
    for (const [pos, frag] of headingHits(m)) {
        hits.push({
            kind: "heuristic",
            rule: "5 title case heading",
            pos,
            frag,
            inQuote: inQuoteAt(m.quoteRanges, pos),
        });
    }
    for (const [pos, frag] of boldHits(m)) {
        hits.push({
            kind: "hard",
            rule: "3/4 bold over 40 chars",
            pos,
            frag,
            inQuote: inQuoteAt(m.quoteRanges, pos),
        });
    }
    for (const [name, pat] of HEUR) {
        for (const hit of findAll(pat, m.t)) {
            const startCp = m.tMap[hit.index];
            if (name === "2 mid-sentence colon") {
                const endCp = m.tMap[hit.index + hit[0].length];
                const after = m.tCps.slice(endCp, endCp + 80).join("");
                if (after.startsWith("\n") || COLON_LIST_AHEAD.test(after))
                    continue;
            }
            hits.push({
                kind: "heuristic",
                rule: name,
                pos: startCp,
                frag: m.tCps
                    .slice(startCp, startCp + 60)
                    .join("")
                    .split("\n")
                    .join(" "),
                inQuote: inQuoteAt(m.quoteRanges, startCp),
            });
        }
    }
    /* Array.prototype.sort is stable (ES2019), like Python's list.sort. */
    hits.sort((a, b) => a.pos - b.pos);
    return hits;
}
export function summarize(hits) {
    const byRule = {};
    let hard = 0;
    let quoted = 0;
    let heuristic = 0;
    for (const h of hits) {
        if (h.kind === "heuristic") {
            heuristic++;
        }
        else if (h.inQuote) {
            quoted++;
        }
        else {
            hard++;
            byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;
        }
    }
    return { hard, quoted, heuristic, byRule };
}
/** Explicit self test. Never runs on import. Returns failure messages; empty means pass. */
export function selfTest() {
    const fails = [];
    const check = (label, got, want) => {
        const g = JSON.stringify(got);
        const w = JSON.stringify(want);
        if (g !== w)
            fails.push(`${label}: got ${g}, want ${w}`);
    };
    const rules = (s) => lintText(s).map((h) => h.rule);
    check("em dash", rules("a b — c"), ["1 em dash"]);
    check("masked fence", rules("```\nlet x = a — b;\n```"), []);
    check("masked inline", rules("`a — b`"), []);
    check("ident mask keeps ascii", rules("foo_bar is simple"), ["16 marketing word"]);
    check("unicode ident mask", rules("한글_토큰 is simple"), ["16 marketing word"]);
    /* Python \b is Unicode aware: "쉬운easy" has no word boundary before "easy". */
    check("unicode word boundary", rules("쉬운easy"), []);
    check("ascii word boundary", rules("an easy win"), ["16 marketing word"]);
    check("quoted hard hit", summarize(lintText('he said "it is simple" ok')).quoted, 1);
    check("emoji needs u flag", rules("ship it 🚀"), ["6 emoji"]);
    const emoji = lintText("🚀 and then simply");
    check("code point pos after non-BMP", emoji.map((h) => h.pos), [0, 11]);
    check("colon before list is skipped", rules("note:\n- a"), []);
    check("colon mid sentence", rules("note: this is fine"), ["2 mid-sentence colon"]);
    check("heuristic frag joins newlines", lintText("very\nlong").map((h) => h.frag), ["very long"]);
    return fails;
}
