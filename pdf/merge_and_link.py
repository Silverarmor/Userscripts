"""
merge_and_link.py  -  CIVIL 756 Phase 2, Team L

Merges the main report PDF and the appendices PDF into
"YYYYMMDD HHMM Merged.pdf" (saved next to the main report PDF) and fixes up
navigation in the merged file.

=====================================================================
CHECKLIST - do these in order before running
=====================================================================
[ ] 1. Appendix page numbering: set the appendix .docx page numbers to
       start at (number of pages in the main PDF + 1). The main PDF must already
       include the A3 drawing sheets and references if they sit before the
       appendices. The script reads the start number from the appendix
       footer and warns if it doesn't match the main PDF's page count.
[ ] 2. Appendix .docx: update all fields (Ctrl+A, F9: captions, TOC),
       then SAVE. The main report's RD field reads the saved file.
[ ] 3. Main report .docx: update all fields (Ctrl+A, F9), including the
       TOC, List of Figures and List of Tables (choose "Update entire
       table" if asked). Check appendix entries show the right pages.
[ ] 4. Export both to PDF (File > Save As > PDF > Options > tick
       "Create bookmarks using: Headings").
[ ] 5. Run (main report first, then appendices):
              pip install pymupdf      (first time only)
              python merge_and_link.py "Main.pdf" "Appendices.pdf"
[ ] 6. Read the report it prints:
         "!" = TOC/list entry it could only link to the top of a page
         "?" = text reference with no target (typo, or a table/figure
               missing from the List of Tables/Figures)
=====================================================================

What it does:
  1. Merges the PDFs. Every link inside each file keeps working (Word
     cross-references, TOC links, URLs), including named destinations.
  2. Merges both files' bookmarks, keeping each bookmark's exact position.
  3. Makes every TOC / List of Figures / List of Tables entry that points
     into the appendix clickable (jumps to the exact heading or caption).
  4. Links plain-text references anywhere in the merged PDF, e.g.
     "Table A1-1", "Figures A2-1 and A2-2", "Appendix B5", "Section A3.2",
     unless the text is already a link. A bare "A3" (e.g. "A3 sheet") is
     never touched.

Optional:  --start N       override the detected appendix start page number
           --toc-pages 1-8 pages of the main PDF scanned for TOC/list lines
           --no-text-refs  skip step 4
"""
import argparse
import datetime
from collections import Counter
from pathlib import Path
import re
import sys

import pymupdf

NUM_AT_END = re.compile(r"^(.*?)[\s.…]*?(\d+)$")
DASHES = str.maketrans({"‑": "-", "‐": "-", "–": "-", "—": "-"})
LABEL = re.compile(r"^(?:\d+|[A-Z]?\d+-\d+)$")           # table/figure: 3, A1-1
SECTION_LABEL = re.compile(r"^(?:[A-Z]|[A-Z]?\d+(?:\.\d+)*)$")
KEYWORDS = {
    "table": "table", "tables": "table",
    "figure": "figure", "figures": "figure", "fig": "figure", "figs": "figure",
    "appendix": "section", "appendices": "section",
    "section": "section", "sections": "section",
}
JOINERS = {"and", "or", "to", "&", "-", ",", "and/or"}


def norm(s):
    s = s.translate(DASHES)
    s = re.sub(r"[.…]{2,}", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def clean_token(w):
    return w.translate(DASHES).strip("()[],;:.’'\"")


def page_lines(page):
    """Visual lines (same baseline), left to right: (text, rect)."""
    words = page.get_text("words")
    lines = []
    for w in sorted(words, key=lambda w: (round(w[3], 0), w[0])):
        if lines and abs(lines[-1]["y"] - w[3]) < 2.5:
            lines[-1]["words"].append(w)
        else:
            lines.append({"y": w[3], "words": [w]})
    out = []
    for ln in lines:
        ws = sorted(ln["words"], key=lambda w: w[0])
        rect = pymupdf.Rect(ws[0][:4])
        for w in ws[1:]:
            rect |= pymupdf.Rect(w[:4])
        out.append((norm(" ".join(w[4] for w in ws)), rect, ws))
    return out


def is_toc_line(ws, page_width):
    """Page number right-aligned at the margin, after dot leaders or a wide tab gap."""
    last = ws[-1][4].strip()
    if ws[-1][2] < 0.7 * page_width:
        return False
    if re.search(r"[.\u2026]{3,}\d+$", last):      # leaders glued to the number
        return True
    if len(ws) < 2 or not last.isdigit():
        return False
    before = ws[-2]
    leaders = re.search(r"[.\u2026]{3,}$", before[4]) is not None
    return leaders or ws[-1][0] - before[2] > 18


def starts_like_entry(text):
    t = text.split()
    if not t:
        return False
    if t[0].lower() in KEYWORDS and len(t) > 1:
        return bool(LABEL.match(clean_token(t[1])) or SECTION_LABEL.match(clean_token(t[1])))
    return bool(LABEL.match(clean_token(t[0])) or SECTION_LABEL.match(clean_token(t[0])))


def find_target(page, title):
    words = title.split()
    for n in (len(words), 8, 5, 3):
        probe = " ".join(words[:n])
        if len(probe) < 4:
            continue
        hits = page.search_for(probe)
        if hits:
            return hits[0]
    return None


def resolved_links(src, names):
    """All links of src as GOTO/URI/GOTOR dicts, named destinations resolved."""
    out = []
    for pno in range(len(src)):
        for lk in src[pno].get_links():
            lk = dict(lk)
            lk.pop("xref", None)
            lk.pop("id", None)
            if lk["kind"] == pymupdf.LINK_NAMED:
                name = lk.get("nameddest") or lk.get("name")
                d = names.get(name)
                if d is None or d.get("page", -1) < 0:
                    print(f"  ! unresolved named link '{name}' on appendix page {pno+1}",
                          file=sys.stderr)
                    continue
                lk = {"kind": pymupdf.LINK_GOTO, "from": lk["from"], "page": d["page"],
                      "to": pymupdf.Point(d.get("to", (0, 0))), "zoom": 0}
            out.append((pno, lk))
    return out


def dest_of(entry_dest, names):
    """Turn a get_toc(simple=False) destination into (page0, Point) or None."""
    if not isinstance(entry_dest, dict):
        return None
    if entry_dest.get("kind") == pymupdf.LINK_NAMED:
        d = names.get(entry_dest.get("nameddest") or entry_dest.get("name"))
        if d:
            return d["page"], pymupdf.Point(d.get("to", (0, 0)))
        return None
    if "to" in entry_dest:
        return None, pymupdf.Point(entry_dest["to"])
    return None


def detect_start(app):
    """Printed page number of the appendix's first page, read from headers/footers."""
    votes = Counter()
    for i in range(min(10, len(app))):
        page = app[i]
        h = page.rect.height
        for w in page.get_text("words"):
            if (w[1] > 0.88 * h or w[3] < 0.10 * h) and w[4].strip().isdigit():
                n = int(w[4])
                if 0 < n - i < 1000:
                    votes[n - i] += 1
    if not votes:
        return None
    start, count = votes.most_common(1)[0]
    return start if count >= min(2, len(app)) else None


def main():
    ap = argparse.ArgumentParser(description="Merge the main report and appendices PDFs")
    ap.add_argument("main_pdf", help="main report PDF")
    ap.add_argument("appendix_pdf", help="appendices PDF")
    ap.add_argument("--start", type=int, help="override detected appendix start page")
    ap.add_argument("--toc-pages", default="1-8")
    ap.add_argument("--no-text-refs", action="store_true")
    a = ap.parse_args()

    main_path, app_path = Path(a.main_pdf).resolve(), Path(a.appendix_pdf).resolve()
    for f in (main_path, app_path):
        if not f.exists():
            sys.exit(f"Can't find {f}")
    out_path = main_path.parent / datetime.datetime.now().strftime("%Y%m%d %H%M Merged.pdf")

    doc = pymupdf.open(main_path)
    app = pymupdf.open(app_path)
    n_main, n_app = len(doc), len(app)

    if a.start is None:
        a.start = detect_start(app)
        if a.start is None:
            a.start = n_main + 1
            print(f"! Couldn't read the appendix page numbers, assuming it starts at "
                  f"{a.start} (main PDF has {n_main} pages). Use --start N if wrong.")
        else:
            print(f"Appendix footer starts at page {a.start}")
    if n_main != a.start - 1:
        print(f"! WARNING: the main PDF has {n_main} pages, so the appendix lands on page "
              f"{n_main + 1}, but its footer says {a.start}. Fix checklist item 1. "
              f"(Links will still go to the right place.)")

    main_names = doc.resolve_names()
    app_names = app.resolve_names()
    toc_main = doc.get_toc(simple=False)
    toc_app = app.get_toc(simple=False)
    app_links = resolved_links(app, app_names)
    main_link_count = sum(len(p.get_links()) for p in doc)

    # ---- 1. merge, then re-create the appendix's own links with shifted pages
    doc.insert_pdf(app, links=False)
    for pno, lk in app_links:
        if lk["kind"] == pymupdf.LINK_GOTO:
            lk["page"] += n_main
        doc[n_main + pno].insert_link(lk)

    # ---- 2. bookmarks (exact positions kept)
    bookmarks = []           # (level, title, page0, Point)
    for lvl, title, page, *rest in toc_main:
        d = dest_of(rest[0] if rest else None, main_names)
        pt = d[1] if d else pymupdf.Point(0, 0)
        pg = d[0] if d and d[0] is not None else page - 1
        bookmarks.append((lvl, title, pg, pt))
    for lvl, title, page, *rest in toc_app:
        d = dest_of(rest[0] if rest else None, app_names)
        pt = d[1] if d else pymupdf.Point(0, 0)
        pg = (d[0] if d and d[0] is not None else page - 1) + n_main
        bookmarks.append((lvl, title, pg, pt))
    if bookmarks:
        try:
            doc.set_toc([[l, t, p + 1, {"kind": pymupdf.LINK_GOTO, "to": pt, "zoom": 0}]
                         for l, t, p, pt in bookmarks])
        except Exception as ex:
            print(f"! could not merge bookmarks ({ex})", file=sys.stderr)

    # ---- 3. TOC / list entries into the appendix; also build the target index
    targets = {}             # ("table"|"figure"|"section", label) -> (page0, Point)
    lo, hi = (int(x) for x in a.toc_pages.split("-"))
    toc_page_set = set(range(lo - 1, min(hi, n_main)))

    def index_entry(title, page0, pt):
        t = title.split()
        if not t:
            return
        kw = KEYWORDS.get(t[0].lower())
        if kw in ("table", "figure") and len(t) > 1 and LABEL.match(clean_token(t[1])):
            targets.setdefault((kw, clean_token(t[1])), (page0, pt))
        else:
            first = clean_token(t[1] if t[0].lower() == "appendix" and len(t) > 1 else t[0])
            if SECTION_LABEL.match(first):
                targets.setdefault(("section", first), (page0, pt))

    for _, title, pg, pt in bookmarks:
        index_entry(norm(title), pg, pt)

    made, missed = 0, []
    toc_rects = {}           # page -> rects of TOC/list lines (skipped in step 4)
    for pno in sorted(toc_page_set):
        page = doc[pno]
        prev_text, prev_rect, prev_entry = "", None, True
        for text, rect, ws in page_lines(page):
            m = NUM_AT_END.match(text)
            if not m or not m.group(1).strip() or not is_toc_line(ws, page.rect.width):
                prev_text, prev_rect, prev_entry = text, rect, False
                continue
            title, printed = norm(m.group(1)), int(m.group(2))
            # entry wrapped over two lines: the first line has no page number
            toc_rects.setdefault(pno, []).append(rect)
            joined = None
            if not prev_entry and prev_text and starts_like_entry(prev_text):
                joined = norm(prev_text + " " + title)
                toc_rects[pno].append(prev_rect)
            if a.start <= printed < a.start + n_app:
                target = n_main + (printed - a.start)
                hit, link_rect = None, rect
                if joined:
                    hit = find_target(doc[target], joined)
                    if hit is not None:
                        link_rect, title = rect | prev_rect, joined
                if hit is None:
                    hit = find_target(doc[target], title)
                if hit is None:
                    missed.append((pno + 1, text))
                for lk in page.get_links():
                    if pymupdf.Rect(lk["from"]).intersects(link_rect):
                        page.delete_link(lk)
                pt = pymupdf.Point(0, max(hit.y0 - 20, 0)) if hit else pymupdf.Point(0, 0)
                page.insert_link({"kind": pymupdf.LINK_GOTO, "from": link_rect,
                                  "page": target, "to": pt, "zoom": 0})
                made += 1
                if hit:
                    index_entry(title, target, pt)
            else:
                # main-report entry: reuse the link Word already put on it
                for lk in page.get_links():
                    if lk["kind"] == pymupdf.LINK_GOTO and pymupdf.Rect(lk["from"]).intersects(rect):
                        pt = pymupdf.Point(lk.get("to", (0, 0)))
                        index_entry(title, lk["page"], pt)
                        if joined:
                            index_entry(joined, lk["page"], pt)
                        break
            prev_text, prev_rect, prev_entry = text, rect, True

    # ---- 4. plain-text references
    ref_links, unresolved = 0, {}
    if not a.no_text_refs:
        for pno in range(len(doc)):
            page = doc[pno]
            existing = [pymupdf.Rect(l["from"]) for l in page.get_links()]
            existing += toc_rects.get(pno, [])
            words = page.get_text("words", sort=False)
            i = 0
            while i < len(words):
                kw = KEYWORDS.get(clean_token(words[i][4]).lower())
                if not kw:
                    i += 1
                    continue
                kw_rect = pymupdf.Rect(words[i][:4])
                if any(kw_rect.intersects(x) for x in toc_rects.get(pno, [])):
                    i += 1                                  # TOC/list line, done in step 3
                    continue
                j, first = i + 1, True
                pattern = SECTION_LABEL if kw == "section" else LABEL
                while j < len(words):
                    raw = words[j][4]
                    tok = clean_token(raw)
                    if not first and tok.lower() in JOINERS:
                        j += 1
                        continue
                    if kw == "section" and "-" in tok:          # range "A1.1-A1.6": link to start
                        parts = tok.split("-")
                        if len(parts) == 2 and all(SECTION_LABEL.match(x) for x in parts):
                            tok = parts[0]
                    if not pattern.match(tok) or words[j][5] != words[i][5]:
                        break                               # not a label, or a different paragraph
                    r = pymupdf.Rect(words[j][:4])
                    dest = targets.get((kw, tok))
                    if dest is None:
                        unresolved.setdefault((kw, tok), pno + 1)
                    else:
                        tpage, tpt = dest
                        # skip the caption/heading itself (or a reference right beside it)
                        is_self = tpage == pno and abs(r.y0 - tpt.y) < 40
                        if first and abs(kw_rect.y1 - r.y1) < 2.5:
                            rects = [kw_rect | r]          # "Table A1-1" as one link
                        elif first:
                            rects = [kw_rect, r]           # keyword and label on two lines
                        else:
                            rects = [r]                    # later labels in a list
                        clash = any(x.intersects(rr) for x in existing for rr in rects)
                        if not is_self and not clash:
                            for rr in rects:
                                page.insert_link({"kind": pymupdf.LINK_GOTO, "from": rr,
                                                  "page": tpage, "to": tpt, "zoom": 0})
                                existing.append(rr)
                            ref_links += 1
                    first = False
                    j += 1
                    nxt = clean_token(words[j][4]).lower() if j < len(words) else ""
                    if not (raw.rstrip().endswith(",") or nxt in JOINERS):
                        break
                i = max(j, i + 1)

    doc.save(out_path, garbage=3, deflate=True)

    # ---- report
    out = pymupdf.open(out_path)
    print(f"Merged {n_main} + {n_app} pages -> {out_path.name}")
    print(f"Bookmarks: {len(toc_main)} main + {len(toc_app)} appendix -> {len(out.get_toc())}")
    print(f"Links kept: main {main_link_count}, appendix {len(app_links)}")
    print(f"TOC/list entries linked into appendix: {made}")
    print(f"Plain-text references linked: {ref_links}")
    for p, t in missed:
        print(f"  ! page {p}: entry not found on target page, linked to page top: {t}")
    for (kw, lab), p in sorted(unresolved.items(), key=lambda x: x[1]):
        print(f"  ? page {p}: no target for {kw} '{lab}' (not in lists/bookmarks), left as text")


if __name__ == "__main__":
    try:
        main()
    finally:
        if sys.stdin and sys.stdin.isatty():
            input("\nPress Enter to close...")
