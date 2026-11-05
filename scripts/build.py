"""Turns the raw OneNote export in data/raw into the dashboard data in site/data and site/img."""
import base64
import collections
import datetime as dt
import hashlib
import html
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

from excel_trips import read_all as read_excel

ROOT =Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SITE = ROOT / "site"
IMG = SITE / "img"
OUT = SITE / "data"
NS = "{http://schemas.microsoft.com/office/onenote/2013/onenote}"

SECTIONS = {
    "3-1": ("민물", "공략법"), "3-2": ("민물", "공부"), "3-3": ("민물", "조행기"),
    "4-1": ("송어", "정보"), "4-2": ("송어", "조행기"), "6.": ("바다", "자료"),
}
PORTS = {"선촌선착장": "선촌", "가경주항": "가경주", "용무치항": "용무치", "간월도선착장": "간월도"}
AMBIGUOUS = {"신촌", "지곡", "냉정", "장계", "새미", "장광", "선촌", "간월도", "가경주", "용무치", "한터", "신기", "유정", "화도"}
EXCEL_SECTION = "4-3. 송어낚시(조과 기록)"
ONENOTE_SOURCE = "원노트 전자필기장"
SUFFIX = r"(?:\s?낚시터|지\b|지[는를의에]|항|선착장|\s?하우스)"
PLACE_ALIAS = {"농촌지하우스": "농촌지"}

# Pages worth reading first for each kind of fishing, in reading order.
ESSENTIALS = {
    "민물": [r"^★ 낚시 시작 전에", r"^낚시를 시작하기 전에", r"^시즌별 기법", r"^공략법 정리\(26", r"^계절별 내림낚시"],
    "송어": [r"^색상의 선택", r"^릴 정비", r"^의복 USB"],
    "바다": [r"체크리스트", r"시작하기 전에 빠르게", r"낚시 방법 - summary", r"^쌍포", r"^\[보트\]", r"포인트 정리", r"^쭈꾸미 공략법\(1\) - 나의"],
}


class Sanitizer(HTMLParser):
    """Keeps only bold/italic/underline and http(s) links from OneNote's inline HTML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.stack = [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a":
            href = (attrs.get("href") or "").strip()
            if re.match(r"https?://", href, re.I):
                self.out.append(f'<a href="{html.escape(href, quote=True)}" target="_blank" rel="noopener noreferrer">')
                self.stack.append("a")
            else:
                self.stack.append("")
        elif tag == "span":
            style = (attrs.get("style") or "").lower()
            close = []
            for test, t in (("font-weight:bold", "b"), ("font-style:italic", "i"), ("underline", "u")):
                if test in style.replace(" ", ""):
                    self.out.append(f"<{t}>")
                    close.append(t)
            self.stack.append(close)
        elif tag == "br":
            self.out.append("<br>")

    def handle_endtag(self, tag):
        if tag in ("a", "span") and self.stack:
            top = self.stack.pop()
            if top == "a":
                self.out.append("</a>")
            elif isinstance(top, list):
                self.out.extend(f"</{t}>" for t in reversed(top))

    def handle_data(self, data):
        self.out.append(html.escape(data))


def clean_inline(s):
    p = Sanitizer()
    p.feed(s or "")
    p.close()
    while p.stack:
        top = p.stack.pop()
        if top == "a":
            p.out.append("</a>")
        elif isinstance(top, list):
            p.out.extend(f"</{t}>" for t in reversed(top))
    return "".join(p.out)


def plain(s):
    p = Sanitizer()
    p.feed(s or "")
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", "".join(p.out)))).strip()


def save_image(el, stats):
    data = el.find(NS + "Data")
    if data is None or not data.text:
        return None
    raw = base64.b64decode(data.text)
    name = hashlib.md5(raw).hexdigest()[:16]
    ext = "png" if raw[:4] == b"\x89PNG" else "jpg" if raw[:2] == b"\xff\xd8" else "gif" if raw[:3] == b"GIF" else "emf"
    final = "png" if ext == "emf" else ext
    if not (IMG / f"{name}.{final}").exists():
        (IMG / f"{name}.{ext}").write_bytes(raw)
    stats[ext] += 1
    return f"img/{name}.{final}"


class PageRender:
    def __init__(self, stats):
        self.stats = stats
        self.text = []
        self.images = 0
        self.missing = 0

    def children(self, parent):
        out = []
        for oec in parent.findall(NS + "OEChildren"):
            out.append(self.oes(oec))
        return "".join(out)

    def oes(self, oec):
        parts = []
        for oe in oec.findall(NS + "OE"):
            parts.append(self.oe(oe))
        return f'<div class="oe-group">{"".join(parts)}</div>'

    def oe(self, oe):
        parts = []
        lst = oe.find(NS + "List")
        for child in oe:
            tag = child.tag.replace(NS, "")
            if tag == "T":
                inline = clean_inline(child.text)
                t = plain(child.text)
                if t:
                    self.text.append(t)
                parts.append(f"<p>{inline}</p>" if inline.strip() else "")
            elif tag == "Table":
                parts.append(self.table(child))
            elif tag == "Image":
                parts.append(self.image(child))
            elif tag == "InsertedFile":
                parts.append(f'<p class="attach">첨부 파일: {html.escape(child.get("preferredName") or "이름 없음")} (원노트에서 열기)</p>')
            elif tag == "InkDrawing" or tag == "InkWord":
                parts.append('<p class="attach">손글씨 (원노트에서 확인)</p>')
        nested = self.children(oe)
        cls = "oe list" if lst is not None else "oe"
        marker = ""
        if lst is not None:
            num = lst.find(NS + "Number")
            marker = f'<span class="mark">{html.escape(num.get("text") or "")}</span>' if num is not None else '<span class="mark">•</span>'
        return f'<div class="{cls}">{marker}<div class="oe-body">{"".join(parts)}{nested}</div></div>'

    def table(self, tbl):
        rows = []
        for row in tbl.findall(NS + "Row"):
            cells = [self.children(cell) for cell in row.findall(NS + "Cell")]
            rows.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
        return f'<div class="table-wrap"><table>{"".join(rows)}</table></div>'

    def image(self, el):
        src = save_image(el, self.stats)
        ocr = el.find(f"{NS}OCRData/{NS}OCRText")
        alt = ""
        if ocr is not None and ocr.text:
            alt = re.sub(r"\s+", " ", ocr.text).strip()
            self.text.append(alt)
        if not src:
            self.missing += 1
            return '<p class="attach">이미지를 가져오지 못했습니다 (원노트에서 확인)</p>'
        self.images += 1
        return f'<img loading="lazy" src="{src}" alt="{html.escape(alt[:200], quote=True)}">'

    def render(self, root):
        items = []
        for child in root:
            tag = child.tag.replace(NS, "")
            if tag not in ("Outline", "Image", "InkDrawing", "InsertedFile"):
                continue
            pos = child.find(NS + "Position")
            y = float(pos.get("y", 0)) if pos is not None else 0
            x = float(pos.get("x", 0)) if pos is not None else 0
            if tag == "Outline":
                body = self.children(child)
            elif tag == "Image":
                body = self.image(child)
            elif tag == "InsertedFile":
                body = f'<p class="attach">첨부 파일: {html.escape(child.get("preferredName") or "이름 없음")} (원노트에서 열기)</p>'
            else:
                body = '<p class="attach">손글씨 (원노트에서 확인)</p>'
            items.append((round(y / 40), x, body))
        items.sort(key=lambda i: (i[0], i[1]))
        return "".join(i[2] for i in items)


def parse_trip(title):
    m = re.match(r"^(\d{4})\.(\d{2})\.(\d{2})\.?\(.\.민물\.(.+?)\)\s*(?:-\s*(.*))?$", title)
    if m:
        y, mo, d, place, sub = m.groups()
        return dict(date=f"{y}-{mo}-{d}", place=PLACE_ALIAS.get(place, place), note=sub or "", other=False)
    m = re.match(r"^(\[타인\]\s*)?조행기\((\d\d)\.(\d\d)\.(\d\d)\.[^.)]+(?:\.([^)]+))?\)\s*(?:-\s*(.*))?$", title)
    if m:
        other, y, mo, d, place, sub = m.groups()
        if not place and sub and sub.endswith("낚시터"):
            place, sub = sub.replace("낚시터", ""), ""
        return dict(date=f"20{y}-{mo}-{d}", place=place, note=sub or "", other=bool(other))
    m = re.match(r"^\[조행기\]\s*(\S+) 출조\((\d\d)\.(\d\d)\.(\d\d)\.[^.]+\.\s*(.+?)\)$", title)
    if m:
        kind, y, mo, d, place = m.groups()
        return dict(date=f"20{y}-{mo}-{d}", place=PORTS.get(place, place), note=f"{kind} 출조", other=False)
    return None


def trip_details(lines):
    info = {}
    joined = "\n".join(lines[:80])
    for i, line in enumerate(lines[:40]):
        if line == "날씨" and i + 1 < len(lines):
            info["weather"] = lines[i + 1][:60]
        if line in ("온도", "기온") and i + 1 < len(lines):
            info["temp"] = lines[i + 1][:30]
        if line == "기법" and i + 1 < len(lines) and "technique" not in info and lines[i + 1] not in ("순서", "시작시간", "종료시간"):
            info["technique"] = lines[i + 1][:50]
    m = re.search(r"날씨\s*:\s*([^\n]{1,90})", joined)
    if m and "weather" not in info:
        info["weather"] = m.group(1).split(". ")[0].strip()
    catches = re.findall(r"조과\s*[:은는]?\s*(\d{1,3})\s*(?:수|마리)", "\n".join(lines))
    if catches:
        info["catch"] = int(catches[-1])
    return info


def excel_page(t, order, modified):
    """One trip from the catch workbooks, shaped like a OneNote page so the rest of the site needs no special case."""
    d = dt.date.fromisoformat(t["date"])
    stamp = f"{d:%y.%m.%d}.{t['weekday']}.{t['place']}"
    lead = t["notes"][0] if t["notes"] else ""
    lead_short = lead if len(lead) <= 40 else lead[:39] + "…"
    title = f"조과 기록({stamp})" + (f" - {lead_short}" if lead_short else "")
    timed = sum(t["hourly"]) if t["hourly"] else 0

    facts = [("날짜", f"{d:%Y.%m.%d} ({t['weekday']})"), ("장소", t["place_label"]), ("총마릿수", f"{t['total']}수")]
    for label, key, unit in (("시간", "hours", ""), ("날씨", "weather", ""), ("입어료", "fee", "원"), ("일출", "sunrise", ""), ("일몰", "sunset", "")):
        if t.get(key) is not None:
            value = f"{t[key]:,}" if key == "fee" else t[key]
            facts.append((label, f"{value}{unit}"))
    rows = "".join(f"<tr><td><b>{html.escape(k)}</b></td><td>{html.escape(str(v))}</td></tr>" for k, v in facts)
    body = [f'<div class="table-wrap"><table>{rows}</table></div>']
    if t["notes"]:
        items = "".join(f'<div class="oe list"><span class="mark">•</span><div class="oe-body"><p>{html.escape(n)}</p></div></div>' for n in t["notes"])
        body.append(f'<h3 class="sheet-head">간단 정리</h3><div class="oe-group">{items}</div>')
    if t["hourly"]:
        cells = [(h, n) for h, n in enumerate(t["hourly"]) if n]
        head = "".join(f"<td><b>{h}시</b></td>" for h, _ in cells)
        vals = "".join(f"<td>{n}</td>" for _, n in cells)
        body.append(f'<h3 class="sheet-head">시간대별 조과 (시각이 기록된 {timed}수)</h3><div class="table-wrap"><table><tr>{head}</tr><tr>{vals}</tr></table></div>')
    if t["marks"]:
        body.append('<h3 class="sheet-head">현장 메모</h3>' + "".join(f"<p>{html.escape(m)}</p>" for m in t["marks"]))
    body.append(f'<p class="attach">원본: {html.escape(t["file"])} · {html.escape(t["sheet"])} 시트</p>')

    rec = dict(
        id=f"x{t['date'].replace('-', '')}", source=t["file"], title=title, fishing="송어", group="조과 기록", section=EXCEL_SECTION, level=1, order=order,
        parents=[], created=t["date"], modified=modified, chars=0, images=0, place=t["place"],
        trip=dict(date=t["date"], place=t["place"], note=lead_short, other=False, catch=t["total"], hourly=t["hourly"], timed=timed),
    )
    for key in ("weather", "hours"):
        if t.get(key):
            rec["trip"][key] = t[key]
    text = " ".join([title, t["place_label"], *t["notes"], *t["marks"]])
    return rec, text, "".join(body)


def main():
    manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
    places = json.loads((ROOT / "scripts" / "places.json").read_text(encoding="utf-8"))
    place_ids = [p["id"] for p in places]
    IMG.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    patterns = {}
    for pid in place_ids:
        patterns[pid] = re.compile(pid + SUFFIX if pid in AMBIGUOUS else re.escape(pid))

    stats = collections.Counter()
    by_section = collections.Counter()
    missing = {}
    pages, texts, htmls = [], {}, {}
    parent_stack = {}
    for m in manifest:
        key = m["key"]
        fishing, group = next(v for k, v in SECTIONS.items() if m["section"].startswith(k))
        root = ET.parse(RAW / f"{key}.xml").getroot()
        r = PageRender(stats)
        body = r.render(root)
        title = m["title"].strip()
        full = " ".join(r.text)
        by_section[m["section"]] += r.images
        if r.missing:
            missing[title] = r.missing

        parent_stack[m["level"]] = title
        parents = [parent_stack[l] for l in range(1, m["level"]) if l in parent_stack]

        trip = parse_trip(title)
        rec = dict(
            id=key, source=ONENOTE_SOURCE, title=title, fishing=fishing, group=group, section=m["section"], level=m["level"], order=m["order"],
            parents=parents[-1:], created=m["created"][:10], modified=m["modified"][:10], chars=len(full), images=r.images,
        )
        if trip:
            trip.update(trip_details(r.text))
            rec["trip"] = trip
            rec["place"] = trip["place"]
        guide = re.match(r"^(덕봉|장광|뒷방울) 공략법", title) or re.match(r"^(상덕) - ", title)
        if guide:
            rec["place"] = guide.group(1)
            rec["guide"] = True
            v = re.search(r"update\.\s*(\d\d)\.(\d\d)\.(\d\d)", title)
            if v:
                rec["version"] = f"20{v.group(1)}-{v.group(2)}-{v.group(3)}"
        mentions = {}
        for pid, pat in patterns.items():
            n = len(pat.findall(full))
            if n and rec.get("place") != pid:
                mentions[pid] = n
        if mentions:
            rec["mentions"] = mentions
        for rank, pat in enumerate(ESSENTIALS.get(fishing, [])):
            if re.search(pat, title):
                rec["essential"] = rank
                break
        pages.append(rec)
        texts[key] = full
        htmls[key] = body

    excel_trips = read_excel(ROOT / "source파일")
    for order, t in enumerate(excel_trips, 1):
        path = ROOT / "source파일" / t["file"]
        modified = dt.date.fromtimestamp(path.stat().st_mtime).isoformat()
        rec, text, body = excel_page(t, order, modified)
        rec["chars"] = len(text)
        mentions = {pid: len(pat.findall(text)) for pid, pat in patterns.items() if pid != rec["place"] and pat.search(text)}
        if mentions:
            rec["mentions"] = mentions
        pages.append(rec)
        texts[rec["id"]] = text
        htmls[rec["id"]] = body

    # EMF is rendered once after all pages are read, since Python has no EMF decoder here.
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         str(ROOT / "scripts" / "convert_emf.ps1"), "-Dir", str(IMG)],
        check=True,
    )

    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    exported = dt.datetime.fromtimestamp((ROOT / "data" / "manifest.json").stat().st_mtime).strftime("%Y-%m-%d %H:%M")
    sources = [dict(
        name=ONENOTE_SOURCE, reflected=exported, latest=max(m["modified"][:10] for m in manifest),
        detail=f"{len(manifest)}페이지",
    )]
    for f in sorted((ROOT / "source파일").glob("*.xlsx")):
        count = sum(t["file"] == f.name for t in excel_trips)
        sources.append(dict(
            name=f.name, reflected=now, latest=dt.date.fromtimestamp(f.stat().st_mtime).isoformat(), detail=f"출조 {count}회",
        ))
    meta = dict(places=places, pages=pages, built=now, sources=sources)
    write_js(OUT / "meta.js", "FISH", meta)
    write_js(OUT / "text.js", "FISH_TEXT", texts)
    write_js(OUT / "html.js", "FISH_HTML", htmls)

    trips = [p for p in pages if p.get("trip")]
    unknown = sorted({p["place"] for p in trips} - set(place_ids))
    print("pages", len(pages), "trips", len(trips), "catch", sum("catch" in p["trip"] for p in trips), "excel", len(excel_trips), "excel total", sum(t["total"] for t in excel_trips))
    print("trip per place", collections.Counter(p["place"] for p in trips).most_common())
    print("unknown places", unknown)
    print("images", dict(stats), dict(by_section))
    print("missing images", sum(missing.values()), missing)
    print("undated in trip sections", [p["title"] for p in pages if p["group"] == "조행기" and not p.get("trip") and p["level"] == 1])


def write_js(path, name, value):
    path.write_text(f"window.{name}=" + json.dumps(value, ensure_ascii=False, separators=(",", ":")) + ";", encoding="utf-8")


if __name__ == "__main__":
    main()
