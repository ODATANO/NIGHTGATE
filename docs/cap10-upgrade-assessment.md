# CAP 10 Upgrade-Assessment (2026-07-09)

Empirisch geprueft: Projektkopie in isoliertem Verzeichnis auf `@sap/cds@10.0.3` + `@sap/cds-dk@10.0.4` gehoben, gebaut und die volle Suite gefahren. Der Working Tree blieb unberuehrt.

## Ergebnis in einem Satz

Machbar mit ueberschaubarem Aufwand (grob 1 Tag): **855 von 863 Tests laufen unter CAP 10 sofort durch**; alle 8 Fehlschlaege haben EINE Ursache (Int64/Decimal kommen als Strings aus der DB), darunter ein echter Runtime-Bug bei uns. Dazu kommen Toolchain-Anpassungen und mittelfristig die Jest-Abloesung.

## Was CAP 10 aendert (relevant fuer NIGHTGATE)

| Aenderung | Impact auf uns |
|---|---|
| Node >= 22 Pflicht | Erfuellt (lokal 22.22.3) |
| Int64/Decimal aus SQLite/Postgres als **Strings** (`ieee754compatible` default true) | **Groesster Punkt**, siehe unten |
| `node:sqlite` wird Default-Treiber; better-sqlite3 optional peer (^12) | `@cap-js/sqlite@3` installiert better-sqlite3 12 weiterhin; unsere `sqlite-tuning.ts` degradiert sauber (no-op ohne `.pragma`) |
| Jest wird zugunsten **Vitest** abgekuendigt | cds 10.0 laeuft noch mit Jest (855 Tests beweisen es), aber die 54 Suiten muessen mittelfristig auf Vitest |
| Async `activate()` aus cds-plugin.js entfernt | Betrifft uns nicht (Standard-Export, kein activate) |
| `.affected` auf Write-Results, Draft-Defaults, Protocol-Adapter als Klassen | Kein Treffer im Code gefunden |
| Entfernte APIs (`authInfo`/`tokenInfo`/`hdbcds`/Compat-Flags) | Kein Treffer im Code |

## Der eine echte Runtime-Bug

`Crawler.getCatchUpStartHeight` rechnet `(syncState.lastIndexedHeight ?? -1) + 1`. Unter CAP 10 ist `lastIndexedHeight` ein String -> `"0" + 1 === "01"` (String-Konkatenation). Der Catch-up fordert dann Bloecke fuer Hoehe "01" an. Genau dieselbe Klasse liegt ueberall, wo Integer64/Decimal-Felder aus der DB arithmetisch verwendet werden ohne `Number()`/`toBigInt`-Koerzierung. Viele Stellen sind schon safe (`Number(...)`-Wraps, `toBigInt` fuer Balances); ein systematischer Audit auf `lastIndexedHeight`, `height`, `chainHeight`, `forkHeight`, `blocksPerSecond` etc. ist noetig. Diese Koerzierungen sind rueckwaertskompatibel und koennen VOR dem Upgrade auf CAP 9 gemergt werden.

## Konsumenten-Impact (NIGHTPASS)

- Unser peer `@sap/cds: >=9.0.0` erlaubt CAP-10-Hosts bereits. Sobald die String-Koerzierungen drin sind, laeuft das Plugin in CAP-9- UND CAP-10-Hosts.
- In einem CAP-10-Host liefern OData-Antworten Integer64/Decimal-Felder (Heights, Balances, Amounts) als **Strings**. NIGHTPASS-Code, der `typeof x === 'number'` erwartet oder rechnet, muss koerzieren.

## Toolchain-Aenderungen (im Trial verifiziert)

- Bumps noetig: `@sap/cds ^10`, `@sap/cds-dk ^10`, `@cap-js/sqlite ^3`, `@cap-js/cds-test ^1`, `@cap-js/cds-types ^0.18` (0.16 peer't cds-dk ^9 -> Konflikt), `@cap-js/cds-typer ^0.40`, `eslint ^10` (cds 10 peer't `@eslint/js ^9||^10`, npm zieht die 10er). eslint 10 laeuft mit unserer Flat-Config ohne Aenderung.
- **cds-typer-Falle:** Unter cds 10 emittiert `cds-typer` per Default `.js`+`.d.ts` statt `.ts`; damit crasht tsc 5.9.3 hart ("Debug Failure" in resolveExternalModule). Workaround verifiziert: `--outputDTsFiles false` im `cds:types`-Script -> emittiert wieder `.ts`, Build laeuft sauber.
- **Lockfile behalten:** Ein frisches Resolve ohne Lockfile zieht neuere Midnight-SDK-4.x, die ein unveroeffentlichtes `@midnight-ntwrk/ledger-v9@0.1.0-alpha` referenzieren (404). Mit Lockfile bleiben die Midnight-Pins stehen, nur die CAP-Pakete bewegen sich.

## Die 8 Testfehlschlaege im Detail

Alle Int64/Decimal-als-String:
- `block-processor-persistence`: `height: "5"` statt `5`.
- `crawler-orchestration` (4): Catch-up-Starthoehe `"01"` (der echte Bug), `forkHeight: "10"` im ReorgLog.
- `nightgate-indexer-service` (3): `chainHeight: "50"`, `blocksPerSecond: "0.00"` etc. in getSyncStatus/getHealth/getReorgHistory-Antworten.

## Empfohlene Reihenfolge

1. **Jetzt:** 0.5.2 (Review-Fixes + Dependency-Updates) unveraendert auf CAP 9 shippen. CAP 10 nicht in dieses Paket mischen.
2. **Vorbereitendes PR (laeuft auf CAP 9 UND 10):** Number()/toBigInt-Audit aller Int64/Decimal-Leser + `--outputDTsFiles false` im cds:types-Script + Test-Assertions koerzierungstolerant machen.
3. **Upgrade-PR:** devDependency-Bumps (Tabelle oben), volle Verifikation inkl. smoke:sdk/integration-Scripts, NIGHTPASS gegen den CAP-10-Host testen (String-Serialisierung!).
4. **Separat, unabhaengig terminierbar:** Jest -> Vitest Migration (54 Suiten, ts-jest-Ersatz), bevor eine spaetere cds-Version Jest endgueltig brechen laesst.

Trial-Verzeichnis (Scratchpad, kann geloescht werden): `.../scratchpad/cap10-trial` mit `jest-cap10.log`.
