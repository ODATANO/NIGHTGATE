# Code Review Findings - 2026-07-08

Review-Ziel: versteckte Bugs, Sicherheitsluecken und Designrisiken im aktuellen Stand von `@odatano/nightgate` finden. Der Review war lesend; es wurden keine Codefixes vorgenommen.

## Kurzfazit

Der Gesamteindruck ist stark: klare Modulgrenzen, viele Tests, saubere TypeScript-/ESLint-Basis und mehrere bewusst gehaertete Sicherheitsentscheidungen, insbesondere bei Wallet-Sessions, Secret-Handling, Mainnet-Gate und Worker-Isolation.

Die groessten Risiken liegen an den operativen Indexer-Kanten: Reorgs, Rollback, teilweise fehlgeschlagene Catch-ups und Zugriffsschutz fuer Betriebsaktionen. Diese Themen sollten vor produktivem Betrieb priorisiert werden.

## Checks

- `npm run typecheck`: bestanden
- `npm run lint`: bestanden
- `npm run test:unit`: bestanden, 53 Test Suites / 838 Tests
- `npm audit --omit=dev`: fehlgeschlagen wegen bekannter Production-Dependency-Vulnerabilities

## Findings

### P1: Indexer-Betriebsaktionen sind nicht geschuetzt

Betroffene Stellen:

- `srv/nightgate-indexer-service.cds`
- Actions: `pauseCrawler`, `resumeCrawler`, `reindexFromHeight`

Problem:

`NightgateIndexerService` hat kein Service-level `@requires`. Gleichzeitig enthaelt der Service mutierende und potentiell destruktive Betriebsaktionen. Ein nicht privilegierter Caller kann dadurch den Crawler stoppen, neu starten oder einen Rollback ab einer beliebigen Hoehe ausloesen.

Impact:

- Denial of Service durch `pauseCrawler`
- Datenverlust oder laengere Inkonsistenz durch `reindexFromHeight`
- Unerwuenschte Betriebssteuerung durch normale API-User

Loesungsvorschlag:

- Read-only Health/Status-Endpunkte offen oder authenticated lassen.
- Mutierende Actions mit `@requires: 'admin'` schuetzen.
- Alternativ: getrennten Admin-/Ops-Service fuer `pauseCrawler`, `resumeCrawler`, `reindexFromHeight` einfuehren.
- Tests ergaenzen, die unauthenticated/non-admin Requests auf diese Actions mit 401/403 erwarten.

Moeglicher CDS-Ansatz:

```cds
@requires: 'admin'
action pauseCrawler() returns { ... };

@requires: 'admin'
action resumeCrawler() returns { ... };

@requires: 'admin'
action reindexFromHeight(height: Integer64) returns { ... };
```

### P1: Catch-up ueberspringt fehlgeschlagene Batches

Betroffene Stellen:

- `srv/crawler/Crawler.ts`
- `runCatchUpPipeline`

Problem:

Wenn ein Batch nach den konfigurierten Retries fehlschlaegt, wird `nextHeightToPersist` auf `head.to + 1` gesetzt. Danach werden spaetere Bloecke weiter persistiert. Dadurch koennen Loecher im lokalen Index entstehen, waehrend `SyncState.lastIndexedHeight` spaeter trotzdem auf eine hohe Blockhoehe zeigt.

Impact:

- Fehlende Bloecke/Transactions im lokalen Index
- `SyncState` signalisiert Fortschritt, obwohl Daten fehlen
- Parent-Verknuepfungen koennen `null` werden, wenn der Parent-Block im ausgelassenen Bereich liegt

Loesungsvorschlag:

- Bei Batch-Fehler nicht ueber den Bereich springen.
- Entweder den Batch erneut in die Queue stellen oder Catch-up stoppen und `syncStatus='error'` setzen.
- `SyncState.lastIndexedHeight` darf nur die letzte lueckenlos persistierte Hoehe repraesentieren.
- Zusaetzlichen Guard in `BlockProcessor.persistFromNode`: Wenn `height > 0` und Parent fehlt, sollte der Block nicht still mit `parent_ID = null` persistiert werden, ausser Genesis/konfigurierter Sonderfall.
- Tests ergaenzen: Batch N fehlschlaegt, Batch N+1 darf nicht persistiert werden.

### P1: Reorg- und Reindex-Rollback machen `NightBalances` nicht rueckgaengig

Betroffene Stellen:

- `srv/crawler/BlockProcessor.ts`
- `srv/crawler/Crawler.ts`
- `srv/nightgate-indexer-service.ts`

Problem:

Der Ingest projiziert Transferdaten in `UnshieldedUtxos` und `NightBalances`. Reorg-/Rollback-Pfade loeschen Bloecke, Transactions und verschiedene Child-Tabellen, korrigieren aber `NightBalances` nicht. Nach einem Reorg oder manuellen Reindex bleiben Balance, UTXO-Count und Aktivitaetszaehler zu hoch oder anderweitig veraltet.

Impact:

- Falsche Kontostaende und Top-Holder-Listen
- Falsche Statistikwerte (`txSentCount`, `txReceivedCount`, `totalSent`, `totalReceived`)
- Dauerhafte Inkonsistenz nach Reorgs oder manuellen Reindex-Operationen

Loesungsvorschlag:

- `NightBalances` als abgeleitete Projektion behandeln.
- Nach Rollback entweder:
  - betroffene Adressen aus geloeschten Transactions sammeln und deren Balances aus verbleibenden UTXOs/Transactions neu berechnen, oder
  - bei jedem Rollback ab Hoehe H alle `NightBalances` abhaengigen Projektionen ab H neu aufbauen.
- Reorg- und manuellen Reindex-Pfad auf eine gemeinsame Rollback-Utility konsolidieren.
- Tests ergaenzen: Transfer in Block 10 erhoeht Balance, Reorg ab 10 muss Balance wieder entfernen/korrigieren.

### P1/P2: Live-Reorg-Erkennung kann alte oder wiederholte Heads falsch klassifizieren

Betroffene Stelle:

- `srv/crawler/Crawler.ts`
- `checkForReorg`

Problem:

Die Reorg-Erkennung vergleicht `header.parentHash` direkt mit `syncState.lastIndexedHash`. Wenn eine Subscription beim Start/Reconnect einen bereits indexierten finalized Head erneut liefert, ist dessen Parent naturgemaess nicht der aktuelle Tip-Hash. Das kann als Reorg fehlklassifiziert werden.

Impact:

- Unnoetige Rollbacks
- Reindex-Aufwand ohne echten Fork
- Risiko fuer Inkonsistenzen, wenn Rollback-Projektionen nicht vollstaendig rueckgaengig gemacht werden

Loesungsvorschlag:

- Vor dem Parent-Vergleich die Hoehe beruecksichtigen:
  - `height <= lastIndexedHeight`: lokalen Block auf gleicher Hoehe lesen; wenn Hash bekannt/gleich, ignorieren.
  - `height === lastIndexedHeight + 1`: Parent-Vergleich wie bisher.
  - `height > lastIndexedHeight + 1`: Gap-Catch-up statt direkter Reorg-Annahme.
- Tests fuer duplicate finalized head und reconnect replay ergaenzen.

### P2: `protocolVersion` wird global gecacht und nach Runtime-Upgrades falsch

Betroffene Stellen:

- `srv/crawler/BlockProcessor.ts`
- `getProtocolVersion`
- `fetchBlockBatch`

Problem:

Nach dem ersten erfolgreichen `state_getRuntimeVersion` wird `specVersion` global gecacht und fuer alle weiteren Bloecke wiederverwendet. Bei Runtime-Upgrades auf der Chain werden spaetere Bloecke dadurch mit einer falschen Protocol-/Spec-Version persistiert.

Impact:

- Historisch falsche Blockmetadaten
- Analysen nach Runtime-Version unzuverlaessig
- Moegliche Parser-/Klassifizierungsfehler, falls spaeter runtime-spezifische Logik hinzukommt

Loesungsvorschlag:

- Cache nicht global nach "erstem Wert", sondern pro Blockbereich oder invalidierbar.
- Einfachste sichere Variante: `state_getRuntimeVersion(blockHash)` fuer jeden Block oder jeden Batch-Hash abfragen.
- Performance-optimierte Variante: Cache mit Intervall/Spec-Version-Grenzen, aber bei Aenderung sauber persistieren.
- Beste Variante fuer Substrate: Runtime-Upgrades ueber bekannte Events/Metadata erkennen und Cache ab diesem Block invalidieren.

### P2: Userbezogene Entity-Reads sind nicht ausreichend gescoped

Betroffene Stellen:

- `srv/nightgate-service.cds`
- `srv/nightgate-service.ts`

Problem:

`WalletSessions` wird als Entity projiziert, zwar ohne verschluesselte Keys, aber mit Session-/User-Metadaten. `PendingSubmissions` wird per `READ` ungefiltert ueber `req.query` zurueckgegeben. `getJobStatus` prueft Ownership, die rohe Entity-Leseflaeche aber nicht im gleichen Umfang.

Impact:

- Ein authentifizierter User kann potentiell Sessions/Submissions anderer User sehen.
- Job-/Submission-Metadaten koennen leaken.
- Session-IDs sind selbst sensible Korrelationstoken, auch wenn sie allein nicht zum Signieren reichen.

Loesungsvorschlag:

- `WalletSessions` und `PendingSubmissions` per `before READ` auf `req.user.id` scopen.
- Alternativ: diese Entities nicht im public `NightgateService` exponieren, sondern nur ueber owner-gepruefte Actions wie `getJobStatus`.
- Fuer `PendingSubmissions` ggf. `sessionId` ueber `WalletSessions.userId` joinen oder `userId` direkt beim Insert mitpersistieren.
- Tests ergaenzen: User A darf Rows von User B nicht sehen.

### P2: Manueller Rollback ist nicht atomar

Betroffene Stelle:

- `srv/nightgate-indexer-service.ts`
- `rollbackFromHeight`

Problem:

`rollbackFromHeight` fuehrt viele Deletes und Updates sequenziell ueber `this.db.run` aus, aber nicht in einer gemeinsamen Transaktion. Ein Fehler in der Mitte kann zu halb geloeschten Tabellen fuehren.

Impact:

- Teilweise geloeschte Child-Tabellen
- Blocks/Transactions/SyncState koennen auseinanderlaufen
- Nachfolgender Crawler-Lauf startet auf inkonsistenter Basis

Loesungsvorschlag:

- `rollbackFromHeight` vollstaendig in `this.db.tx(async tx => { ... })` kapseln.
- Reorg- und manuellen Rollback auf dieselbe Utility abstrahieren, damit Fixes nicht doppelt gepflegt werden muessen.
- Nach dem Rollback Projektionen wie `NightBalances` ebenfalls im selben kontrollierten Ablauf korrigieren.

### P2: Bekannte Production-Dependency-Vulnerabilities

Betroffene Stellen:

- `package.json`
- `package-lock.json`

Audit-Ergebnis:

`npm audit --omit=dev` meldet 6 Vulnerabilities, darunter high severity in:

- `path-to-regexp`
- `undici`
- `ws`

Sowie moderate Findings ueber `qs` / `body-parser` / `express`.

Impact:

- Potentielle DoS-Risiken ueber Routing/Parsing/WebSocket-Handling
- Transport-/HTTP-Client-Risiken ueber `undici`

Loesungsvorschlag:

- `npm audit fix` in separatem Branch testen.
- Wenn `npm audit fix` zu breit ist: gezielte Updates fuer `express`, `undici`, `ws` und transitive Overrides pruefen.
- Danach vollstaendig laufen lassen:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run test:unit`
  - relevante Integration-/Smoke-Tests

## Empfohlene Priorisierung

1. Indexer-Betriebsaktionen schuetzen.
2. Catch-up-Fehlerpfad korrigieren, sodass keine Hoehen uebersprungen werden.
3. Reorg-/Rollback-Projektionen, insbesondere `NightBalances`, konsistent machen.
4. Live-Reorg-Erkennung gegen duplicate/replayed heads haerten.
5. Userbezogene Reads scopen oder entfernen.
6. Dependency-Audit-Fixes in separatem Upgrade-Branch einspielen.
7. `protocolVersion`-Cache runtime-upgrade-sicher machen.

## Gute bestehende Punkte

- TypeScript strict + sauberer Typecheck.
- Umfangreiche Unit-Suite mit 838 Tests.
- Wallet-Sessions sind an `userId` gebunden.
- Secrets werden in Job-Requests bewusst nicht persistiert.
- Encrypted Keys werden bei Disconnect/Expiry geloescht und Facades werden best-effort aus dem Speicher entfernt.
- Mainnet-Submission ist standardmaessig blockiert.
- Long-running SDK-/Wallet-Arbeit ist ueber Worker und Background-Jobs entkoppelt.
- CAP-Modell-Initialisierung und Schema-Deploy-Checks sind explizit bedacht.

