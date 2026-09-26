# UEFA Nations League – Vormlijst

Dashboard dat voor elke groep van de UEFA Nations League een ranglijst toont op basis van de
**laatste 5 gespeelde interlands** van elk land. Dat mogen wedstrijden uit alle competities zijn
(Nations League, WK-kwalificatie, EK, vriendschappelijk, enz.).

- Winst = 3 punten, gelijkspel = 1 punt, verlies = 0 punten
- Bij gelijke punten: doelsaldo, daarna gemaakte doelpunten
- Een strafschoppenserie telt als gelijkspel (de uitslag na 90/120 minuten telt)
- 4 rijen: League A, B, C (elk 4 groepen) en League D (in 2026-27: 2 groepen van 3 landen)
- Lay-out geïnspireerd op Top Notch: zwart-wit, grote koppen, vinyl en goud als accent

## Hoe het werkt

| Onderdeel | Wat het doet |
|---|---|
| `index.html` | De dashboardpagina. Leest `data/form.js` en werkt ook als je het bestand gewoon opent (`file://`). |
| `scripts/update-form.mjs` | Haalt bij [API-Football](https://www.api-football.com/) de groepsindeling en per land de laatste 5 wedstrijden op, en schrijft `data/form.json` + `data/form.js`. |
| `.github/workflows/update-form.yml` | Draait elke nacht om **03:00 (Nederlandse tijd)**. Ververst alleen als er **gisteren** een wedstrijd was van een deelnemend land. |

Eén volledige verversing kost ongeveer 56 API-verzoeken. Dat past binnen het gratis plan van
API-Football (100 per dag). Het script wacht 6,5 seconden tussen verzoeken, omdat het gratis plan
maximaal 10 verzoeken per minuut toestaat. Een verversing duurt daardoor ongeveer 6 minuten.

## Installatie

1. Maak een account aan op <https://dashboard.api-football.com> en kopieer je API-key.
2. Ga in GitHub naar **Settings → Secrets and variables → Actions** en voeg het secret
   `API_FOOTBALL_KEY` toe.
3. Ga naar **Actions → Vormlijst verversen → Run workflow**. Deze eerste run vult het dashboard.
4. Optioneel: zet **Settings → Pages** op de standaard-branch (root). Dan staat het dashboard online.

Lokaal draaien:

```bash
API_FOOTBALL_KEY=jouw_key node scripts/update-form.mjs --force
open index.html
```

Andere instellingen: `NL_SEASON` (standaard `2026` = seizoen 2026-27) en `REQUEST_DELAY_MS`.

> Let op: API-Football beperkt op het gratis plan soms de toegang tot bepaalde seizoenen en
> parameters. Geeft de workflow een API-fout, dan staat de precieze melding in de log van de run.
