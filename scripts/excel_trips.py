"""Reads the per-trip trout catch sheets (source파일/*.xlsx) into plain trip records."""
import datetime as dt
import re
from pathlib import Path

import openpyxl

SHEET = re.compile(r"^(\d{2})(\d{2})(\d{2})\s*(.)-(.+)$")
PLACES = {"신기지": "신기", "지곡지": "지곡", "장광지": "장광", "양벌": "양벌", "어우실": "어우실", "화도": "화도", "추곡": "추곡", "유정": "유정"}
SUMMARY_DATE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{2})$")


def as_hour(v):
    if isinstance(v, (dt.time, dt.datetime)):
        return v.hour
    return None


def hhmm(v):
    return f"{v.hour:02d}:{v.minute:02d}" if isinstance(v, (dt.time, dt.datetime)) else None


def read_summary(wb):
    """Weather and fishing hours per date, from the season summary sheet when there is one."""
    out = {}
    for ws in wb.worksheets:
        if "결산" not in ws.title or ws.title.startswith("송어결산"):
            continue
        rows = list(ws.iter_rows(values_only=True))
        head = next((r for r in rows if "날짜" in r), None)
        if not head:
            continue
        col = {name: i for i, name in enumerate(head) if name}
        for r in rows:
            m = SUMMARY_DATE.match(str(r[col["날짜"]]))
            if m:
                y, mo, d = m.groups()
                out[f"20{y}-{mo}-{d}"] = dict(
                    hours=r[col["시간"]], weather=r[col["날씨"]], fee=r[col["입어료"]],
                    sunrise=hhmm(r[col["일출"]]), sunset=hhmm(r[col["일몰"]]),
                )
    return out


def read_trip(ws, summary):
    m = SHEET.match(ws.title)
    if not m:
        return None
    y, mo, d, _, place = m.groups()
    place = place.strip()
    date = f"20{y}-{mo}-{d}"
    # computed, because one sheet name has the wrong weekday (190608일 was a Saturday)
    weekday = "월화수목금토일"[dt.date.fromisoformat(date).weekday()]

    # The hourly table sits at a different column on each sheet: find its "시간" header outside column B.
    hourly = [0] * 24
    notes = []
    table_cells = set()
    headers = [(c.row, c.column) for row in ws.iter_rows() for c in row if c.value == "시간" and c.column_letter != "B"]
    for (r, col) in headers:
        table_cells |= {(r, col), (r, col + 1)}
        for rr in range(r + 1, ws.max_row + 1):
            h = as_hour(ws.cell(rr, col).value)
            v = ws.cell(rr, col + 1).value
            if h is None:
                break
            table_cells |= {(rr, col), (rr, col + 1)}
            if isinstance(v, (int, float)):
                hourly[h] = int(v)

    catches, marks = [], []
    for row in ws.iter_rows(min_row=2):
        for c in row:
            v = c.value
            if v is None or (c.row, c.column) in table_cells:
                continue
            if c.column == 2 and c.row > 3:
                t = hhmm(v)
                if t:
                    catches.append(t)
            elif c.column == 3 and c.row > 3 and isinstance(v, str):
                t = hhmm(ws.cell(c.row, 2).value)
                marks.append(f"{t} {v}" if t else v)
            elif c.column >= 4 and isinstance(v, str) and v.strip() not in ("간단 정리", "시간") and not re.fullmatch(r"\d+;\d+", v.strip()):
                notes.append(re.sub(r"^\d+\.\s*", "", v.strip()))

    extra = summary.get(date, {})
    return dict(
        date=date, weekday=weekday, place=PLACES.get(place, place), place_label=place, total=ws["B1"].value,
        # an all-zero table means the times were not recorded that day (190421), not that nothing was caught
        hourly=hourly if any(hourly) else None, catches=catches, marks=marks, notes=notes,
        weather=extra.get("weather"), hours=extra.get("hours"), fee=extra.get("fee"),
        sunrise=extra.get("sunrise"), sunset=extra.get("sunset"), sheet=ws.title,
    )


def read_all(folder):
    trips = []
    for f in sorted(Path(folder).glob("*.xlsx")):
        wb = openpyxl.load_workbook(f, data_only=True)
        summary = read_summary(wb)
        for ws in wb.worksheets:
            trip = read_trip(ws, summary)
            if trip:
                trip["file"] = f.name
                trips.append(trip)
    return sorted(trips, key=lambda t: t["date"])
