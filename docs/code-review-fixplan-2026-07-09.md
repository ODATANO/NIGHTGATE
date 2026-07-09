# Fix-Plan zu den Code-Review-Findings vom 2026-07-08

**Update 2026-07-09: ALLE Fixes (1-8) sind umgesetzt** (uncommitted, working tree). typecheck + lint gruen, volle Suite 54/54 Suiten, 863/863 Tests, smoke:sdk + integration:providers + integration:contract-registry gruen. Umsetzungsnotizen:

- Fix 8: `npm audit` ist jetzt komplett sauber (0 Vulnerabilities, prod UND dev). Drei Schritte: (1) `npm audit fix` behob alle Production-Findings (path-to-regexp, undici, ws 8.21.0, qs/body-parser/express) rein im Lockfile; (2) `npm update @sap/cds-dk` 9.7.2 -> 9.9.3 beseitigte die in cds-dk gebuendelten Dev-Findings (axios/handlebars/form-data u.a.); (3) `npm update tsx` 4.21 -> 4.23 zog esbuild auf 0.28.1 (letztes low-severity-Finding). `package.json` blieb unveraendert, alles innerhalb der Semver-Ranges; nur `package-lock.json` hat sich geaendert. `@sap/cds`-Runtime blieb auf 9.7.1.

- Fix 1: `@requires: 'admin'` auf den drei Actions; Probes/Status bleiben offen. Model-Assertion-Tests (dummy-Auth im Testprofil macht 403-HTTP-Tests sinnlos, Enforcement ist CAP-generisch).
- Fix 2: Fehlgeschlagener Batch wird genau einmal an den Queue-Kopf re-enqueued; zweiter Fehlschlag stoppt den Lauf mit `syncStatus: 'error'`. `nextHeightToPersist` wird bei Fehlern nie mehr vorgerueckt. Parent-Guard: `persistPreparedBlock` (Pipeline) und `processBlockByHeight` (Live) werfen bei fehlendem Parent oberhalb Genesis; `processBlockByHash` (on-demand per Hash) behaelt bewusst den lenienten `parent_ID = null` Fallback.
- Fix 3: Neue Utility `srv/crawler/rollback.ts` (`rollbackIndexedDataFromHeight`), genutzt von `handleReorg` UND `reindexFromHeight`. Recompute pro betroffener Adresse aus verbleibenden UTXOs/Transactions; Zeilen ohne Restaktivitaet werden geloescht (ausser sie tragen DUST-Linkage). Tests beweisen: Rollback stellt den exakten Vorzustand her, Re-Index kann nicht doppelt zaehlen.
- Fix 4: `checkForReorg` mit Hoehen-Guard (replayed Head -> ignorieren, Gap -> kein Reorg, Genesis-Replay -> nie zurueckrollen); `processLiveBlock` faengt Gaps ab und ruft `catchUp()` statt Einzelblock-Verarbeitung.
- Fix 5: `before READ WalletSessions` filtert auf `req.user.id`; `READ PendingSubmissions` filtert auf die Session-IDs des Callers (Join ueber `WalletSessions.userId`, kein Schemawechsel). Admin liest ungefiltert.
- Fix 6: `rollbackFromHeight` laeuft in einem expliziten `db.tx`, das VOR dem Crawler-Restart committet; damit ist auch das Pre-Commit-Race weg. Response-Shape unveraendert (`crawlerResumed` bleibt).
- Fix 7: `getProtocolVersion` fragt immer per Block/Batch ab; der Cache ist nur noch Fallback bei RPC-Fehlern (1 zusaetzlicher RPC pro 32er-Batch).
- Doku: `docs/actions.md` (admin-Gate) und `docs/reference.md` (READ-Scoping) aktualisiert.
- Betriebs-Gotcha aus der Umsetzung: `npm run build` kompiliert in-place; der CAP-Boot laedt die kompilierten `.js` neben den `.ts`. Nach reinen `.ts`-Aenderungen vor `npm test` bauen (`npm run test:unit` tut das automatisch).

Verifikation am 2026-07-09 gegen `main` (f8a8839). Ergebnis: 6 von 7 Findings sind echte Befunde, 1 Finding (Atomaritaet des manuellen Rollbacks) ist durch CAPs Request-Transaktion weitgehend entschaerft, hat aber einen realen Rest-Bug (Crawler-Restart vor Commit).

## Verifikationsstatus

| # | Finding | Status | Beleg |
|---|---------|--------|-------|
| 1 | Indexer-Betriebsaktionen ungeschuetzt | BESTAETIGT (P1) | `nightgate-indexer-service.cds` hat kein `@requires`; `admin-service.cds:7` und `nightgate-service.cds:10` haben es. Handler pruefen nichts. |
| 2 | Catch-up ueberspringt fehlgeschlagene Batches | BESTAETIGT (P1) | `Crawler.ts:332` setzt `nextHeightToPersist = head.to + 1` im catch-Zweig; Folge-Batches werden weiter persistiert. Zusatz: `BlockProcessor.ts:404` persistiert `parent_ID: null` still, wenn der Parent fehlt. |
| 3 | Reorg/Reindex rollen `NightBalances` nicht zurueck | BESTAETIGT (P1, schwerer als beschrieben) | Weder `Crawler.handleReorg` (Z. 585-666) noch `rollbackFromHeight` (`nightgate-indexer-service.ts:40-127`) fassen `NightBalances` an. Da `upsertNightBalance` (`BlockProcessor.ts:666`) Delta-basiert ist, zaehlt der Re-Index nach jedem Rollback ALLE Betraege/Counter doppelt. Jeder Reorg (auch korrekt erkannte) korrumpiert also Balances dauerhaft. |
| 4 | Reorg-Fehlklassifikation bei replayed Heads | BESTAETIGT (P1 wegen Kopplung mit #3) | `checkForReorg` (`Crawler.ts:529-547`) vergleicht nur `parentHash != lastIndexedHash`, ohne Hoehen-Guard. Replayed finalized Head bei Reconnect -> `findForkPoint` findet den Parent lokal -> unnoetiger Rollback + Re-Index -> via #3 doppelte Balances. |
| 5 | `protocolVersion` global gecacht | BESTAETIGT (P2) | `cachedSpecVersionValid` (`BlockProcessor.ts:143`) wird nach dem ersten Erfolg nie wieder invalidiert (`getProtocolVersion`, Z. 805-818). Runtime-Upgrades werden nicht bemerkt. |
| 6 | Entity-Reads nicht user-gescoped | BESTAETIGT (P2) | `WalletSessions`-Projektion (`nightgate-service.cds:564`) exkludiert nur die Key-Felder, kein READ-Scoping auf `userId`. `PendingSubmissions`-READ (`nightgate-service.ts:188`) reicht `req.query` ungefiltert durch. Die Actions selbst sind sauber user-gebunden (0.5.0), nur die rohe Entity-Flaeche nicht. |
| 7 | Manueller Rollback nicht atomar | TEILWEISE | Die `this.db.run`-Aufrufe laufen innerhalb des `reindexFromHeight`-Handlers und werden von CAP automatisch in der Request-Transaktion gebuendelt (Commit bei Erfolg, Rollback bei Fehler). Halb geloeschte Tabellen sind damit weitgehend abgedeckt. REAL bleibt: `startCrawler` wird VOR dem Commit der Request-Tx aufgerufen (Z. 351), der neu gestartete Crawler kann also den Pre-Rollback-SyncState lesen. Ausserdem Code-Duplikation mit `handleReorg` (Drift-Risiko). |
| 8 | npm audit Production-Vulns | BESTAETIGT (P2) | Reproduziert 2026-07-09: 6 Vulnerabilities (3 high: `path-to-regexp`, `undici`, `ws`; 3 moderate via `qs`/`body-parser`/`express`). Alle mit `fix available via npm audit fix`. |

## Fix-Plan (Reihenfolge = Umsetzungsreihenfolge)

### Fix 1: Indexer-Actions absichern (klein, isoliert)

- In `srv/nightgate-indexer-service.cds` die drei mutierenden Actions mit `@requires: 'admin'` annotieren: `pauseCrawler`, `resumeCrawler`, `reindexFromHeight`.
- Service-Level-`@requires` bewusst NICHT setzen: `getLiveness`/`getReadiness`/`getMetrics` muessen fuer K8s-Probes und Prometheus anonym erreichbar bleiben. Read-only Status-Funktionen bleiben offen (nur unkritische Sync-Metadaten).
- Tests: mit `auth.kind: mocked` (Testprofil-Override, dummy-Auth skippt `@requires`) pruefen, dass non-admin auf die drei Actions 403 bekommt und admin durchkommt. Bestehende Handler-Tests bleiben unveraendert (mocked admin-User).

### Fix 2: Catch-up darf keine Hoehen ueberspringen

`srv/crawler/Crawler.ts`, `runCatchUpPipeline` catch-Zweig (Z. 320-333):

- Statt `nextHeightToPersist = head.to + 1`:
  1. Fehlgeschlagenen Batch genau EINMAL neu an den Queue-Kopf stellen (`queue.unshift({ from: head.from, to: head.to, data: this.fetchBlockBatchWithRetry(...) })`), Retry-Marker am Batch mitfuehren.
  2. Schlaegt der Retry ebenfalls fehl: `break outer`, `syncStatus: 'error'` setzen und `nextHeightToPersist` NICHT anfassen. Der naechste Catch-up-Lauf startet dann wieder bei `lastIndexedHeight + 1`.
- Wichtig: Nach `break` sind die vorgefetchten Folge-Batches im Queue obsolet (werden bereits best-effort verworfen, Z. 339-341); kein weiterer Persist danach.
- Guard in `BlockProcessor.persistFromNode` (Z. 404): wenn `height > 0` und kein `parentBlock` gefunden -> Error werfen statt still `parent_ID: null` zu persistieren. Damit werden Luecken zu lauten Fehlern statt stillen Loechern. Genesis (`height === 0`) bleibt Ausnahme.
- Tests: (a) Batch N schlaegt zweimal fehl -> kein Block aus N+1 persistiert, syncStatus 'error', lastIndexedHeight = letzte lueckenlose Hoehe. (b) Batch N schlaegt einmal fehl, Retry ok -> alles persistiert. (c) persistFromNode ohne Parent bei height > 0 -> wirft.

### Fix 3: Gemeinsame Rollback-Utility inkl. NightBalances-Korrektur (groesster Brocken)

Neues Modul `srv/crawler/rollback.ts` mit `rollbackIndexedDataFromHeight(tx, fromHeight)`, genutzt von `Crawler.handleReorg` UND `NightgateIndexerService.rollbackFromHeight`:

1. Vor den Deletes betroffene Adressen einsammeln: `senderAddress`/`receiverAddress` aus den zu loeschenden `Transactions` plus `owner` aus betroffenen `UnshieldedUtxos` (created und spent).
2. Bestehende Delete-Kaskade unveraendert uebernehmen (Blocks, Transactions, ContractActions, ContractBalances, UnshieldedUtxos, Zswap/Dust-Events, Fees, Results, Segments, Spent-Unlink).
3. Danach pro betroffener Adresse die `NightBalances`-Zeile aus den VERBLEIBENDEN Daten neu berechnen (kein Delta-Patch):
   - `balance`/`utxoCount`: Aggregat ueber verbleibende unspent `UnshieldedUtxos` des Owners.
   - `txSentCount`/`txReceivedCount`/`totalSent`/`totalReceived`/`lastActivityHeight`: Aggregate ueber verbleibende `Transactions`/`UnshieldedUtxos`.
   - Keine verbleibende Aktivitaet -> Zeile loeschen.
4. `SyncState`-Update wie bisher am Ende derselben Tx.
- `handleReorg` behaelt sein `db.tx`-Wrapping und ruft die Utility darin auf; der Indexer-Service ruft sie in einem expliziten `this.db.tx` auf (siehe Fix 7).
- Tests: Transfer in Block 10 erhoeht Balance -> Rollback ab 10 stellt exakten Vorzustand wieder her (Balance, Counts, Totals, utxoCount); Re-Index desselben Blocks ergibt wieder exakt den Nachzustand (kein Double-Count). Zusatztest fuer Adresse, die nach Rollback keine Historie mehr hat -> Zeile weg.

### Fix 4: Hoehen-Guard in der Reorg-Erkennung

`srv/crawler/Crawler.ts`, `checkForReorg`:

- `newHeight` zuerst parsen, dann:
  - `newHeight <= lastIndexedHeight`: lokalen Block auf `newHeight` lesen; gleicher Hash -> replayed Head, ignorieren (return null). Anderer Hash -> echter Fork, Reorg wie bisher.
  - `newHeight === lastIndexedHeight + 1`: Parent-Vergleich wie bisher.
  - `newHeight > lastIndexedHeight + 1`: kein Reorg; Gap -> normalen Catch-up anstossen (Aufrufer signalisieren, z. B. Rueckgabetyp um `{ gap: true }` erweitern oder im Live-Handler pruefen).
- Tests: (a) replayed bereits indexierter finalized Head -> kein Rollback; (b) gleicher Hoehe, anderer Hash -> Reorg; (c) Gap von N Bloecken -> Catch-up statt Rollback; (d) regulaerer Fork -> unveraendertes Verhalten.

### Fix 5: PendingSubmissions/WalletSessions READ auf req.user scopen

`srv/nightgate-service.ts`:

- `before READ WalletSessions`: Query um `where userId = req.user.id` ergaenzen (CQN-append). Admin-Rolle darf ungefiltert lesen.
- `READ PendingSubmissions`: Session-IDs des Callers aufloesen (`SELECT sessionId from WalletSessions where userId = req.user.id`) und `sessionId in (...)` an `req.query` anhaengen; leere Liste -> leeres Ergebnis. Admin ungefiltert. Kein Schemawechsel noetig (kein neues `userId`-Feld auf PendingSubmissions, kein apply-schema-delta fuer Consumer).
- Tests: User A sieht weder Sessions noch Submissions von User B; admin sieht alles; unauth -> 401 (Service hat bereits `@requires: 'authenticated-user'`).

### Fix 6: reindexFromHeight-Handler haerten (baut auf Fix 3 auf)

`srv/nightgate-indexer-service.ts`:

- `rollbackFromHeight` durch Aufruf der gemeinsamen Utility in einem expliziten `this.db.tx(async tx => ...)` ersetzen (explizit statt implizit, gleiche Semantik wie im Crawler-Pfad, kein Drift mehr).
- `startCrawler` NICHT mehr direkt im Handler aufrufen, sondern in `req.on('succeeded', ...)` verschieben, damit der Crawler erst nach Commit der Request-Tx startet und nie den Pre-Rollback-SyncState liest. Response-Feld `crawlerResumed` wird dann zu `crawlerResumeScheduled` (Doc + Test anpassen) oder der Resume bleibt synchron NACH einem expliziten Commit.
- Test: Fehler mitten im Rollback -> keine Teilloeschung sichtbar (alles oder nichts); Crawler-Restart erst nach erfolgreichem Rollback.

### Fix 7: protocolVersion-Cache runtime-upgrade-sicher

`srv/crawler/BlockProcessor.ts`:

- Kompromiss aus Korrektheit und RPC-Last: `state_getRuntimeVersion` einmal pro Batch (erster Hash des Batches, Z. 265-267) IMMER abfragen statt den Cache-Short-circuit zu nehmen; im Live-Pfad pro Block abfragen. Der Cache bleibt nur als Fallback bei RPC-Fehlern (bisheriges catch-Verhalten).
- Kosten: 1 zusaetzlicher RPC pro 32er-Batch im Catch-up, 1 pro Live-Block. Vernachlaessigbar gegenueber den 2 Batch-Roundtrips.
- Aufloesung ist damit batch-granular: ein Upgrade mitten im Batch wird erst ab dem naechsten Batch abgebildet (bewusster Trade-off, dokumentieren).
- Test: getRuntimeVersion liefert erst 5, dann 6 -> Bloecke des zweiten Batches werden mit 6 persistiert.

### Fix 8: Dependency-Updates (separater Branch)

- Branch `chore/audit-fixes`, dort `npm audit fix` (kein `--force`).
- Betroffen: `path-to-regexp`, `undici`, `ws`, `qs`/`body-parser`/`express`. Alle Fixes sind laut audit ohne Major-Breaks verfuegbar.
- Achtung: `ws` wird vom Ogmios-/Substrate-WebSocket-Pfad genutzt, `undici` von fetch-basierten SDK-Teilen. Nach dem Update zwingend: `npm run typecheck`, `npm run lint`, `npm test`, `npm run smoke:sdk`, `npm run integration:providers`.

## Aufwand und Release

- Fix 1, 5, 7: je klein (unter 1h inkl. Tests).
- Fix 2, 4: mittel (Pipeline-/Erkennungslogik + Tests).
- Fix 3 + 6: zusammen der Hauptaufwand (gemeinsame Utility, Recompute-Aggregate, Testmatrix).
- Fix 8: mechanisch, aber mit voller Verifikationsrunde.
- Kein Schema-Delta noetig (keine neuen Spalten/Tabellen) -> Consumer brauchen kein `apply-schema-delta.mjs`.
- Vorschlag: alles zusammen als 0.5.2 (reine Fixes, keine API-Aenderung ausser dem Auth-Verhalten der Indexer-Actions und dem Scoping der Entity-Reads; beides in den Release Notes als behavioral change ausweisen).
