# PixelBoard – Web-App fürs iPixel-LED-Board (ohne PC)

Stöbern, Vorschau ansehen und GIFs, Bilder oder Text direkt vom Handy per **Web Bluetooth**
ans iPixel-Color-Board schicken (BK-Light ACT1026, 32×32). Alles läuft im Browser, ein
Server ist nicht nötig.

## Voraussetzungen

- Android-Handy mit **Chrome**. Samsung Internet und Firefox unterstützen Web Bluetooth
  nicht zuverlässig.
- Die Seite muss über **https://** laufen. Am einfachsten geht das mit GitHub Pages
  (kostenlos).

## Auf GitHub Pages veröffentlichen (einmalig, ca. 5 Minuten)

1. Auf github.com ein neues Repository anlegen, z. B. `pixelboard` (Public).
2. Den Inhalt dieses Ordners hochladen:
   ```fish
   cd pixelboard-web
   git init -b main
   git add .
   git commit -m "PixelBoard"
   git remote add origin https://github.com/<dein-name>/pixelboard.git
   git push -u origin main
   ```
   Alternativ geht es ohne git: im Repo auf **Add file → Upload files** tippen und alle
   Dateien samt Ordner `js/` hineinziehen.
3. Im Repo **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`** wählen.
4. Nach 1–2 Minuten ist die Seite unter `https://<dein-name>.github.io/pixelboard/` erreichbar.
5. Am Handy in Chrome öffnen, im Menü **„App installieren“** bzw. **„Zum Startbildschirm
   hinzufügen“** wählen.

## Erste Verbindung

1. **iPixel-App schließen.** Das Board akzeptiert immer nur eine Verbindung.
2. Oben rechts auf **Verbinden** tippen. Chrome fragt nach Bluetooth- bzw.
   „Geräte in der Nähe“-Berechtigung und zeigt dann eine Geräteliste.
3. `LED_BLE_…` auswählen. Oben erscheint **32×32**.

## Bedienung

- **Galerie:** Quelle wählen, suchen, Bild antippen. Die Vorschau zeigt exakt die Datei,
  die gesendet wird. **Füllen** schneidet zu, **Einpassen** lässt Ränder.
  **Aufs Board** sendet, **Merken** speichert in „Meine Bibliothek“.
- **＋** fügt Bilder oder GIFs aus der Handy-Galerie hinzu. Sie werden nur auf diesem
  Handy im Browser gespeichert.
- **Text:** Lauftext mit Farbe, Animation, Regenbogen und Emojis. Die Vorschau zeigt die
  echten Pixel.
- **Steuerung:** Helligkeit, Ein/Aus, Uhr, Verbindung. Unter **Erweitert** lassen sich
  Paketgröße, Auto-Trennen und die maximale Frame-Anzahl einstellen.

## Wenn es hakt

- **„Schreib-Charakteristik fa02 nicht gefunden“:** Der Bluetooth-Dienst des Boards steht
  nicht in der Liste der freigegebenen Dienste. Öffne nRF Connect, verbinde dich mit dem
  Board und notiere die UUID des Dienstes, der die Charakteristik `FA02` enthält. Die wird
  dann in `js/ble.js` bei `SERVICE_CANDIDATES` ergänzt.
- **Senden bricht ab / Timeout:** Unter Steuerung → Erweitert die **Paketgröße** auf
  180 oder 128 Byte stellen.
- **Board taucht nicht in der Liste auf:** Die iPixel-App hält wahrscheinlich die
  Verbindung. Schließe sie (oder schalte Bluetooth kurz aus und an). Notfalls hilft
  **Alle BT-Geräte**.
- **Lange GIFs dauern ewig:** Unter Erweitert die maximale Frame-Anzahl auf 32 setzen.

## Quellen & Lizenzen

- Bilder: PIXEL LED Art (Al Linke), PIXEL (onebeartoe), SmartMatrix-Beispiele – nur
  privat nutzen. OpenMoji (CC BY-SA 4.0), Twemoji (CC BY 4.0).
- 16×16: „Dungeon-Helden & Monster“ = 16x16 DungeonTileset II von 0x72 (CC0, Frames liegen
  in `assets/0x72/`, die App baut daraus GIFs). „Silk-Icons“ = famfamfam Silk von Mark James
  (CC BY 2.5). Neu erzeugen mit `python tools/add_16px_sources.py`.
- Das Protokoll ist portiert aus [pypixelcolor](https://github.com/lucagoc/pypixelcolor)
  (MIT), jede Übertragung ist byte-identisch zur Python-Version getestet.
- GIF-Encoder: [gifenc](https://github.com/mattdesl/gifenc) (MIT, siehe
  `js/vendor/gifenc-LICENSE.md`).
- Die Quellenliste `sources_index.json` stammt aus `update_index.py` der PC-Version.
