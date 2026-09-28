# UEFA Nations League – Vormlijst

Dashboard dat voor elke groep van de UEFA Nations League een ranglijst toont op basis van de
**laatste 5 gespeelde interlands** van elk land. Dat mogen wedstrijden uit alle competities zijn
(Nations League, WK-kwalificatie, EK, vriendschappelijk, enz.).

- Winst = 3 punten, gelijkspel = 1 punt, verlies = 0 punten
- Bij gelijke punten: doelsaldo, daarna gemaakte doelpunten
- Een strafschoppenserie telt als gelijkspel (de uitslag na 90/120 minuten telt)
- 4 rijen: League A, B, C (elk 4 groepen) en League D (in 2026-27: 2 groepen van 3 landen)
- Lay-out geïnspireerd op top-notch.nl: rood, zwart en wit, brede extra vette koppen (Archivo Expanded), rode footerband

## Hoe het werkt

| Onderdeel | Wat het doet |
|---|---|
| `index.html` | De dashboardpagina. Leest `data/form.js` en werkt ook als je het bestand gewoon opent (`file://`). |
| `landen.js` | Nederlandse namen voor landen en competities. |
| `scripts/update-form.mjs` | Haalt bij de openbare ESPN-API de groepsindeling en per land de laatste 5 wedstrijden op, en schrijft `data/form.json` + `data/form.js`. |
| `.github/workflows/update-form.yml` | Draait elke nacht om **03:00 (Nederlandse tijd)**. Ververst alleen als er **gisteren** een wedstrijd was van een deelnemend land. |

De ESPN-API is gratis en heeft geen key nodig. Hij is wel **officieus** (niet gedocumenteerd), dus
ESPN kan hem zonder waarschuwing veranderen. Het script logt daarom per groep en per land wat het
vindt; bij problemen staat de oorzaak in de log van de workflow-run.

Per land zoekt het script in deze competities, telkens in het huidige en het vorige seizoen:
Nations League, vriendschappelijk, WK, WK-kwalificatie, EK en EK-kwalificatie.

## Installatie

1. Ga naar **Actions → Vormlijst verversen → Run workflow**. Deze eerste run vult het dashboard.
2. Zet **Settings → Pages** op branch `main`, map `/ (root)`. Het dashboard staat dan op
   `https://<gebruikersnaam>.github.io/<repo-naam>/`.

Lokaal draaien:

```bash
node scripts/update-form.mjs --force
open index.html
```

Andere instellingen: `NL_SEASON` (standaard `2026` = seizoen 2026-27) en `REQUEST_DELAY_MS`.
