"""Writes CHANGELOG.md from site/versions.js, so GitHub shows the same history as the Version tab."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_versions():
    source = (ROOT / "site" / "versions.js").read_text(encoding="utf-8")
    entries = re.finditer(
        r'version: "([^"]+)", date: "([^"]+)", title: "([^"]+)",\s*changes: \[(.*?)\],\s*\},',
        source,
        re.S,
    )
    return [
        dict(version=m[1], date=m[2], title=m[3], changes=re.findall(r'"((?:[^"\\]|\\.)*)"', m[4]))
        for m in entries
    ]


def main():
    lines = ["# 변경 이력", "", "`site/versions.js`에서 만든 문서입니다. 대시보드의 Version 탭과 내용이 같습니다.", ""]
    for v in read_versions():
        lines += [f"## v{v['version']} ({v['date']}) {v['title']}", ""]
        lines += [f"- {c}" for c in v["changes"]]
        lines.append("")
    lines += ["v1.0부터 v1.5까지는 Git을 쓰기 전의 작업이라 v1.6 커밋에 함께 들어 있고, 개별 태그가 없습니다.", ""]
    (ROOT / "CHANGELOG.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
