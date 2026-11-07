#!/usr/bin/env python3
"""
Ergänzt sources_index.json um die GIF-Sammlung von GeekMagic
(https://github.com/GeekMagicClock/gif):

  - "GeekMagic – 80×80":       alle GIFs aus "gif 80x80px" (inkl. Unterordner)
  - "GeekMagic – 64×64/64×32": GIFs/JPGs aus "gif 64x64px" und "gif 64x32px"
  - "GeekMagic – 240×240":     nur Dateien bis MAX_BIG_KB, weil die App die
                               Vorschaubilder direkt lädt und die großen GIFs
                               dort bis zu 15 MB haben

Die Bilder bleiben auf GitHub; hier landet nur die Dateiliste. Videos (mp4)
und zu große Dateien werden übersprungen. Erneutes Ausführen ersetzt die
GeekMagic-Einträge, andere Quellen bleiben unverändert.

Aufruf im Repo-Hauptordner:  python tools/add_geekmagic_sources.py
"""

import json
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "sources_index.json"
REPO = "GeekMagicClock/gif"
BRANCH = "main"
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/"
MAX_SMALL_KB = 900          # 80er/64er: praktisch alles
MAX_BIG_KB = 500            # 240er: nur die kleineren
LICENSE = "GeekMagic-GIF-Sammlung – ohne Lizenzangabe, nur privat nutzen"

SOURCES = [
    # id, Name, Ordner im Repo, Größenlimit, Dateiendungen
    ("geekmagic-80", "GeekMagic – 80×80", ["gif 80x80px"], MAX_SMALL_KB, (".gif",)),
    ("geekmagic-64", "GeekMagic – 64×64 & 64×32", ["gif 64x64px", "gif 64x32px"], MAX_SMALL_KB, (".gif", ".jpg", ".png")),
    ("geekmagic-240", "GeekMagic – 240×240 (kleine)", ["gif 240x240px"], MAX_BIG_KB, (".gif",)),
]


def list_repo():
    """[(pfad, bytes)] aller Dateien, ohne die Bilder herunterzuladen."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--no-checkout",
                        f"https://github.com/{REPO}.git", tmp], check=True)
        out = subprocess.run(["git", "-C", tmp, "-c", "core.quotePath=false", "ls-tree", "-r", "-l", "-z", "HEAD"],
                             check=True, capture_output=True).stdout
    files = []
    for rec in out.split(b"\0"):
        if not rec:
            continue
        meta, path = rec.split(b"\t", 1)
        size = meta.split()[3]
        files.append((path.decode("utf-8"), int(size) if size.isdigit() else 0))
    return files


def label(stem, n):
    """Lesbarer Name: Kryptisches (ezgif-…, Zeitstempel, reine Zahlen) wird durchnummeriert."""
    if re.fullmatch(r"(ezgif-\d+-[0-9a-f]+|\d+|[0-9a-f]{6,}|IMG_\d+)", stem, re.I):
        return f"GIF {n}"
    return re.sub(r"[_+]+", " ", stem).strip() or f"GIF {n}"


def main():
    files = list_repo()
    idx = json.loads(INDEX.read_text(encoding="utf-8"))
    keep = [s for s in idx["sources"] if not s["id"].startswith("geekmagic-")]
    added = []
    for sid, name, folders, max_kb, exts in SOURCES:
        items, n = [], 0
        for folder in folders:
            for path, size in sorted(files):
                if not path.startswith(folder + "/") or not path.lower().endswith(exts):
                    continue
                if size > max_kb * 1024:
                    continue
                n += 1
                rel = path[len(folder) + 1:]
                stem = rel.rsplit("/", 1)[-1].rsplit(".", 1)[0]
                # Pfad relativ zu RAW, URL-kodiert (Leerzeichen, Unicode, "+")
                items.append([quote(path, safe="/"), label(stem, n)])
        added.append({
            "id": sid, "name": name, "repo": REPO, "branch": BRANCH, "pixelart": False,
            "license": LICENSE, "license_url": f"https://github.com/{REPO}",
            "base": RAW, "items": items,
        })
        print(f"{name}: {len(items)} Dateien")
    # direkt hinter die anderen Animationsquellen, vor die Emoji-Sammlungen
    pos = next((i for i, s in enumerate(keep) if s["id"] in ("openmoji", "twemoji")), len(keep))
    idx["sources"] = keep[:pos] + added + keep[pos:]
    INDEX.write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")
    print(f"{INDEX.name} aktualisiert")


if __name__ == "__main__":
    main()
