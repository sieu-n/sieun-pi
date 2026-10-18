"""linear-ticket: check, capture diagrams for, and push a Linear ticket in Sieun's shape.

Tickets start with 3-5 short core bullets, followed by useful owner-facing sections.
Read SKILL.md before writing one.
"""
from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path
import re
import uuid
from typing import Any

BANNED = [
    "delve", "leverage", "utilize", "facilitate", "robust", "seamless", "comprehensive",
    "pivotal", "meticulous", "paramount", "crucial", "enhance", "streamline", "holistic",
    "arguably", "essentially", " actually", " simply", " just ", " very ", " really ",
    "it's worth noting", "as mentioned", "this section", "serves as",
]
MAX_BYTES = 8000
MAX_WORDS = 22
MAX_CODE_LINES = 14


def _strip_code(md: str) -> str:
    return re.sub(r"```.*?```", "", md, flags=re.S)


def check(path_or_text: str) -> list[str]:
    """Check a ticket.md against the shape. Returns the list of violations (empty when clean).

    Pass a file path or the markdown text itself.
    """
    md = Path(path_or_text).read_text() if os.path.exists(path_or_text) else path_or_text
    out: list[str] = []
    body = _strip_code(md)
    if "\u2014" in md or "\u2013" in md:
        out.append("long dash found")
    if re.search(r"[\u2018\u2019\u201c\u201d]", md):
        out.append("curly quote found")
    prose = re.sub(r"(?m)^\|.*$", "", _strip_code(re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)))
    if len(prose.encode()) > MAX_BYTES:
        out.append(f"over {MAX_BYTES} bytes of prose, tables and code excluded")
    opening = []
    for line in md.splitlines():
        if not line.strip():
            continue
        bullet = re.fullmatch(r"[-*+] (.+)", line)
        if not bullet:
            break
        opening.append(bullet.group(1))
    if not 3 <= len(opening) <= 5:
        out.append(f"start with 3-5 short core bullets, found {len(opening)}")
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith(("#", "|", "![", "<")) or re.fullmatch(r"\[[^\]]+\]\([^)]+\)", s):
            continue
        s = re.sub(r"^(?:[-*+] |\d+\. )", "", s)
        plain = re.sub(r"`[^`]*`", "", s)
        plain = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", plain)
        ends = len(re.findall(r"[.!?](\s|$)", plain))
        if ends != 1 and not plain.endswith(":"):
            out.append(f"one sentence per line, found {ends}: {s[:70]}")
        if s in opening and ends != 1:
            out.append(f"core bullet must be one sentence: {s[:70]}")
        if len(plain.split()) > MAX_WORDS:
            out.append(f"too long ({len(plain.split())} words, cap {MAX_WORDS}): {s[:70]}")
        if re.search(r"[a-z\)] ?: [a-z]", plain) and not re.search(r"(?:^|\. )(?:Sieun|Options|States|Required|Optional|Today|After)[^.]*:", plain):
            out.append(f"mid-sentence colon: {s[:70]}")
    low = body.lower()
    hits = sorted({w.strip() for w in BANNED if w in low})
    quoted = re.findall(r'"([^"]+)"', body)
    hits = [h for h in hits if not any(h in q.lower() for q in quoted)]
    if hits:
        out.append(f"banned words: {hits}")
    for blk in re.findall(r"```.*?```", md, flags=re.S):
        if blk.count("\n") - 1 > MAX_CODE_LINES:
            out.append(f"code block over {MAX_CODE_LINES} lines")
    for tok in re.findall(r"(?<!`)\b[\w/.-]+\.(?:py|ts|svelte|mjs|json|yaml|md):\d+", body):
        out.append(f"file:line token outside backticks, Linear will autolink it: {tok}")
    imgs = re.findall(r"!\[[^\]]*\]\((assets/[^)]+)\)", md)
    if os.path.exists(path_or_text):
        base = os.path.dirname(os.path.abspath(path_or_text))
        for rel in imgs:
            if not os.path.exists(os.path.join(base, rel)):
                out.append(f"image missing on disk: {rel}")
    for line in out:
        print("  -", line)
    if not out:
        print("  clean")
    return out


def backtick_files(text: str) -> str:
    """Wrap bare file tokens (foo.py, a/b.ts:12) in backticks outside existing code spans."""
    parts = re.split(r"(`[^`]*`|```.*?```)", text, flags=re.S)
    pat = re.compile(
        r"(?<![`\w/.-])((?:[\w.-]+/)*[\w.-]+\.(?:py|ts|mjs|json|yaml|md|txt|svelte)"
        r"(?::\d+(?:-\d+)?(?:,\s?\d+(?:-\d+)?)*)?)(?![`\w/])"
    )
    return "".join(p if p.startswith("`") else pat.sub(r"`\1`", p) for p in parts)


async def _sleep(ms: int) -> None:
    import aside_browser
    await aside_browser.run(f"await new Promise(r => setTimeout(r, {int(ms)}))")


async def capture_diagrams(page_url: str, out_dir: str) -> list[str]:
    """Capture rendered Mermaid SVGs from a caller-selected page through Aside.

    The page host must render SVGs inside every <pre class="mermaid"> before capture.
    Tall diagrams are zoomed to fit the viewport. Returns the saved PNG paths.
    """
    from PIL import Image
    import aside_browser

    os.makedirs(out_dir, exist_ok=True)
    await aside_browser.open_tab(page_url)
    try:
        await _sleep(3500)
        v = "n_" + uuid.uuid4().hex[:6]
        rendered = json.loads((await aside_browser.run(f"""
        const {v} = await page.evaluate(() => Array.from(document.querySelectorAll('pre.mermaid'), el => {{
          const svg = el.querySelector('svg');
          if (!svg) return false;
          const rect = svg.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }}));
        console.log(JSON.stringify({v}))""")).strip().splitlines()[-1])
        if not isinstance(rendered, list) or not all(isinstance(item, bool) for item in rendered):
            raise RuntimeError("Aside returned an invalid Mermaid rendering check. No screenshots were taken.")
        if not rendered or not all(rendered):
            raise RuntimeError(
                "Mermaid diagrams are not ready. No screenshots were taken. "
                "Use a page URL whose host renders a visible SVG inside every pre.mermaid element. "
                "build_page() writes an HTML fragment; it does not load a Mermaid renderer."
            )
        paths: list[str] = []
        for i in range(len(rendered)):
            rv = "r_" + uuid.uuid4().hex[:6]
            out = await aside_browser.run(f"""
            const {rv} = await page.evaluate(async (i) => {{
              document.documentElement.style.zoom = '';
              await new Promise(res => setTimeout(res, 200));
              const el = document.querySelectorAll('pre.mermaid')[i];
              let r = el.getBoundingClientRect();
              const vh = window.innerHeight, vw = window.innerWidth;
              let z = 1;
              if (r.height > vh - 60 || r.width > vw - 60) {{ z = Math.max(0.3, Math.min((vh - 60) / r.height, (vw - 60) / r.width)); document.documentElement.style.zoom = String(z); }}
              await new Promise(res => setTimeout(res, 300));
              el.scrollIntoView({{block: 'center', inline: 'center'}});
              await new Promise(res => setTimeout(res, 400));
              r = el.getBoundingClientRect();
              return {{x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio}};
            }}, {i});
            console.log(JSON.stringify({rv}))""")
            rect = json.loads(out.strip().splitlines()[-1])
            tmp = os.path.join(out_dir, f"full-{i}.png")
            await aside_browser.screenshot(tmp)
            im = Image.open(tmp)
            d = rect["dpr"]
            box = (
                max(0, int((rect["x"] - 6) * d)), max(0, int((rect["y"] - 6) * d)),
                min(im.width, int((rect["x"] + rect["w"] + 6) * d)), min(im.height, int((rect["y"] + rect["h"] + 6) * d)),
            )
            dst = os.path.join(out_dir, f"d{i + 1}.png")
            im.crop(box).save(dst)
            os.remove(tmp)
            paths.append(dst)
        await aside_browser.run("await page.evaluate(() => { document.documentElement.style.zoom = ''; })")
        print(f"  {len(paths)} diagrams -> {out_dir}")
        return paths
    finally:
        await aside_browser.close_tab()


async def upload_image(issue: str, path: str, filename: str | None = None) -> str:
    """Upload one image to a Linear issue and return the assetUrl for markdown."""
    import httpx
    import linear

    filename = filename or os.path.basename(path)
    size = os.path.getsize(path)
    ctype = mimetypes.guess_type(path)[0] or "image/png"
    prep = await linear.prepare_attachment_upload(issue=issue, filename=filename, contentType=ctype, size=size)
    prep = json.loads(prep) if isinstance(prep, str) else prep
    ur = prep["uploadRequest"]
    headers = ur.get("headers") or {}
    if isinstance(headers, list):
        headers = {h["key"]: h["value"] for h in headers}
    with open(path, "rb") as f:
        resp = httpx.put(ur["url"], content=f.read(), headers=headers, timeout=60)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"PUT failed {resp.status_code}: {resp.text[:200]}")
    return prep["assetUrl"]


async def push(issue: str, ticket_md: str, title: str | None = None, force: bool = False) -> dict[str, Any]:
    """Push ticket.md to a Linear issue: check, backtick file tokens, upload images, save, read back.

    Refuses when check() finds violations unless force=True.
    """
    import linear

    violations = check(ticket_md)
    if violations and not force:
        raise ValueError(f"ticket fails check(): {violations}")
    folder = os.path.dirname(os.path.abspath(ticket_md))
    md = backtick_files(Path(ticket_md).read_text().strip())
    for rel in list(dict.fromkeys(re.findall(r"!\[[^\]]*\]\((assets/[^)]+)\)", md))):
        url = await upload_image(issue, os.path.join(folder, rel), f"{issue}-{os.path.basename(rel)}")
        md = md.replace(f"]({rel})", f"]({url})")
    kwargs: dict[str, Any] = {"id": issue, "description": md}
    if title:
        if len(title) > 80:
            raise ValueError("title over 80 chars (rule 9)")
        kwargs["title"] = title
    await linear.save_issue(**kwargs)
    d = await linear.get_issue(id=issue)
    d = json.loads(d) if isinstance(d, str) else d
    bad = [b for b in re.findall(r"\]\(<?http://[^)>]*>?\)", d["description"]) if "localhost" not in b]
    result = {
        "issue": issue,
        "title": d["title"],
        "bytes": len(md),
        "images": d["description"].count("<linear-image>"),
        "autolinks": bad,
        "url": d.get("url"),
    }
    print("  ", result)
    if bad:
        print("  fix these autolinked tokens (write `file.py` line N) and push again")
    return result


async def run(ticket_md: str, issue: str | None = None, page_url: str | None = None, title: str | None = None, force: bool = False) -> dict[str, Any]:
    """Whole pipeline: capture diagrams from the spec page (if page_url), check the ticket, push it (if issue)."""
    folder = os.path.dirname(os.path.abspath(ticket_md))
    if page_url:
        await capture_diagrams(page_url, os.path.join(folder, "assets", "diagrams"))
    violations = check(ticket_md)
    if issue:
        return await push(issue, ticket_md, title=title, force=force)
    return {"violations": violations}


def build_page(ticket_md: str, page_path: str, *, title: str, summary: str, apps: list[str], tags: list[str],
               ticket_url: str, request: str, mermaid: list[str], agent_notes: list[str], related_html: str = "") -> str:
    """Build an HTML fragment from ticket.md for a caller-selected page host.

    The host supplies page layout and Mermaid rendering; this function loads neither.
    Bullets and numbered lines become lists; `## X` becomes `N · X`; a diagram image
    `assets/diagrams/dN.png` becomes the Nth mermaid source; other images become figures; tables and
    code fences carry over; agent_notes land in a <details> block after the last section.
    """
    import html as _h
    md = Path(ticket_md).read_text() if os.path.exists(ticket_md) else ticket_md
    lines = md.split("\n")
    head_props = {}
    body_start = 0
    for i, ln in enumerate(lines):
        m = re.match(r"^(Spec page|Mock|Size): (.*)$", ln)
        if m:
            head_props[m.group(1)] = m.group(2); body_start = i + 1
        elif ln.strip():
            break
    out: list[str] = []
    meta = {"title": title, "date": __import__("datetime").date.today().isoformat(), "updated": __import__("datetime").date.today().isoformat(),
            "apps": apps, "tags": tags, "status": "draft", "owner": "agent", "summary": summary}
    out.append("<!--wiki\n" + json.dumps(meta) + "\n-->")
    out.append(f"<h1>{_h.escape(title)}</h1>")
    out.append(f"<wiki-tldr><strong>What.</strong> {_h.escape(summary)} <strong>Read this if.</strong> You approve or build this ticket.</wiki-tldr>")
    props = [("Ticket", f'<a href="{ticket_url}">{_h.escape(ticket_url.rsplit("/",1)[-1])}</a>')]
    if "Size" in head_props:
        props.append(("Size", _h.escape(head_props["Size"])))
    props.append(("Request", _h.escape(request)))
    if "Mock" in head_props:
        mock_url = head_props["Mock"].split(" ")[0]
        props.append(("Mock", f'<a href="{mock_url}">{_h.escape(head_props["Mock"])}</a>'))
    out.append("<table><tbody>" + "".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in props) + "</tbody></table>")

    def inline(s: str) -> str:
        s = _h.escape(s)
        s = re.sub(r"`([^`]*)`", r"<code>\1</code>", s)
        s = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', s)
        return s

    sec = 0
    i = body_start
    list_tag = None
    def close_list():
        nonlocal list_tag
        if list_tag:
            out.append(f"</{list_tag}>")
            list_tag = None
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("## "):
            close_list(); sec += 1
            name = ln[3:].strip()
            out.append(f'<h2 id="s{sec}">{sec} · {_h.escape(name)}</h2>')
        elif m := re.match(r"^(?:(\d+)\. |[-*+] )(.+)$", ln):
            tag = "ol" if m.group(1) else "ul"
            if list_tag != tag:
                close_list()
                start = f' start="{m.group(1)}"' if tag == "ol" else ""
                out.append(f"<{tag}{start}>")
                list_tag = tag
            out.append(f"\t<li>{inline(m.group(2))}</li>")
        elif ln.startswith("!["):
            close_list()
            m = re.match(r"!\[([^\]]*)\]\(([^)]+)\)", ln)
            cap, src = m.group(1), m.group(2)
            dm = re.match(r"assets/diagrams/d(\d+)\.png", src)
            if dm and int(dm.group(1)) - 1 < len(mermaid):
                out.append('<pre class="mermaid">\n' + mermaid[int(dm.group(1)) - 1] + "\n</pre>")
            else:
                out.append(f'<figure><img src="{src}" alt="{_h.escape(cap)}"><figcaption>{_h.escape(cap)}</figcaption></figure>')
        elif ln.startswith("|"):
            close_list()
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")]); i += 1
            i -= 1
            body_rows = [r for r in rows[1:] if not all(set(c) <= set("-: ") for c in r)]
            out.append("<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in rows[0]) + "</tr></thead><tbody>" +
                       "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body_rows) + "</tbody></table>")
        elif ln.startswith("```"):
            close_list()
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i]); i += 1
            out.append("<pre><code>" + _h.escape("\n".join(code)) + "</code></pre>")
        elif ln.strip():
            close_list()
            out.append(f"<p>{inline(ln)}</p>")
        i += 1
    close_list()
    if agent_notes:
        last = max([int(m.group(1)) for m in re.finditer(r"(?m)^(\d+)\. ", md)] or [0])
        out.append('<details><summary>Agent notes, low level</summary>')
        out.append(f'<ol start="{last + 1}">' + "".join(f"\n\t<li>{n}</li>" for n in agent_notes) + "\n</ol></details>")
    out.append('<h2 id="related">Related</h2>')
    out.append(f"<p>{related_html or ''}</p>")
    html_text = "\n\n".join(out) + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(page_path)), exist_ok=True)
    Path(page_path).write_text(html_text)
    print(f"  page -> {page_path} ({len(html_text)} bytes)")
    return html_text
