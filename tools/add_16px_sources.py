#!/usr/bin/env python3
"""
Ergänzt sources_index.json um die 16x16-Quellen:
  - "Dungeon-Helden & Monster": lokale Frames in assets/0x72 (Animationen werden gruppiert)
  - "Silk-Icons": famfamfam Silk (GitHub, Dateiliste per git)

Aufruf im Repo-Hauptordner:  python tools/add_16px_sources.py
"""

import json
import re
import subprocess
import tempfile
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "sources_index.json"
FRAMES = ROOT / "assets" / "0x72"

NICE = {
    "knight": "Ritter", "elf": "Elfe", "wizzard": "Zauberer", "dwarf": "Zwerg", "lizard": "Echse",
    "big_demon": "Großer Dämon", "big_zombie": "Großer Zombie", "tiny_zombie": "Mini-Zombie",
    "ice_zombie": "Eis-Zombie", "zombie": "Zombie", "skelet": "Skelett", "goblin": "Goblin",
    "imp": "Imp", "chort": "Chort", "ogre": "Oger", "orc_warrior": "Ork-Krieger",
    "orc_shaman": "Ork-Schamane", "masked_orc": "Maskierter Ork", "necromancer": "Nekromant",
    "angel": "Engel", "doc": "Doktor", "pumpkin_dude": "Kürbiskopf", "wogol": "Wogol",
    "slug": "Schnecke", "tiny_slug": "Mini-Schnecke", "swampy": "Sumpfling", "muddy": "Schlammling",
    "chest_full_open": "Truhe (voll)", "chest_empty_open": "Truhe (leer)",
    "chest_mimic_open": "Mimic-Truhe", "coin": "Münze", "bomb": "Bombe",
}
SUFFIX = {"idle": "steht", "run": "läuft", "hit": "getroffen"}


def nice_name(key: str) -> str:
    m = re.match(r"^(.*?)(?:_(idle|run|hit))?$", key)
    base, act = m.group(1), m.group(2)
    gender = ""
    g = re.match(r"^(.*)_(m|f)$", base)
    if g and g.group(1) in NICE:
        base, gender = g.group(1), " ♂" if g.group(2) == "m" else " ♀"
    label = NICE.get(base, base.replace("_", " ").capitalize()) + gender
    if act:
        label += f" ({SUFFIX[act]})"
    return f"{label} · {key.replace('_', ' ')}"


def dungeon_source() -> dict:
    groups: "OrderedDict[str, list[str]]" = OrderedDict()
    singles = []
    for p in sorted(FRAMES.glob("*.png")):
        m = re.match(r"^(.*?)(?:_anim)?_f(\d+)\.png$", p.name)
        if m:
            groups.setdefault(m.group(1), []).append((int(m.group(2)), p.name))
        else:
            singles.append(p.name)
    items = []
    for key, frames in groups.items():
        frames = [n for _, n in sorted(frames)]
        items.append([frames[0], nice_name(key), frames] if len(frames) > 1 else [frames[0], nice_name(key)])
    for name in singles:
        stem = name[:-4]
        items.append([name, stem.replace("_", " ")])
    # Animationen zuerst, Figuren vor Gegenständen
    items.sort(key=lambda it: (len(it) < 3, it[1].lower()))
    return {
        "id": "dungeon16",
        "name": "Dungeon-Helden & Monster (16×16)",
        "repo": "local", "branch": "",
        "pixelart": True,
        "frame_ms": 110,
        "license": "16x16 DungeonTileset II von 0x72 – CC0",
        "license_url": "https://0x72.itch.io/dungeontileset-ii",
        "base": "assets/0x72/",
        "items": items,
    }


def silk_source() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--no-checkout",
                        "https://github.com/markjames/famfamfam-silk-icons.git", tmp], check=True)
        names = subprocess.run(["git", "-C", tmp, "ls-tree", "-r", "--name-only", "HEAD", "icons/"],
                               check=True, capture_output=True, text=True).stdout.split()
    items = sorted(([n[len("icons/"):], n[len("icons/"):-4].replace("_", " ")]
                    for n in names if n.endswith(".png")), key=lambda x: x[1])
    return {
        "id": "silk16",
        "name": "Silk-Icons (16×16)",
        "repo": "markjames/famfamfam-silk-icons", "branch": "master",
        "pixelart": True,
        "license": "famfamfam Silk von Mark James – CC BY 2.5",
        "license_url": "http://www.famfamfam.com/lab/icons/silk/",
        "base": "https://raw.githubusercontent.com/markjames/famfamfam-silk-icons/master/icons/",
        "items": items,
    }


def main() -> None:
    data = json.loads(INDEX.read_text(encoding="utf-8"))
    sources = [s for s in data["sources"] if s["id"] not in ("dungeon16", "silk16")]
    # nach den Pixel-Art-Quellen einsortieren, vor den Emojis
    pos = next((i for i, s in enumerate(sources) if s["id"] in ("openmoji", "twemoji")), len(sources))
    new = [dungeon_source(), silk_source()]
    data["sources"] = sources[:pos] + new + sources[pos:]
    INDEX.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    for s in new:
        anims = sum(1 for it in s["items"] if len(it) > 2)
        print(f"{s['name']}: {len(s['items'])} Einträge ({anims} Animationen)")


if __name__ == "__main__":
    main()
