# Manage My Finance's local API

Manage My Finance can serve JSON on this machine so other tools (scripts, shortcuts, an AI agent, a
phone over Tailscale) can read your finances and change them **through the plugin**, never by editing the
CSV and JSON files behind its back. Every call runs the same code the buttons run. Filing a row teaches
merchant memory, approving a queue confirms merchants, an import is one undoable batch, and a report is
built by the same builder the Reports page uses, so a number fetched here can't disagree with the screen.

The API is **off by default**. With it off the plugin doesn't open a socket, doesn't load Node's `http`
module, and behaves exactly as it did before the API existed.

## Switching it on

Vault settings (Obsidian's Settings → *Manage My Finance*) → **Local API**:

1. Turn on **Enable local API**. A token is generated the first time.
2. Copy the token (the eye shows it, the copy button copies it). Change the port if 27128 is taken.

By default it listens on `127.0.0.1` only, so nothing else on the network can reach it, and Obsidian
has to be running with the vault open. **Listen on** can widen that to your Tailscale address; see
[From your phone (Tailscale)](#from-your-phone-tailscale).

The API needs the **desktop app**. The mobile app has no Node to serve with, so there the setting
explains why it isn't available and the plugin never tries to start a server.

## Base URL and versioning

```
http://127.0.0.1:27128/mmf/v1
```

Every route lives under `/mmf/v1`. `GET /health` reports `"api": 1`. That number goes up only when a
change would break an existing client; new fields in a response and new routes don't count, so a client
should ignore fields it doesn't know.

```bash
export MMF=http://127.0.0.1:27128/mmf/v1
export TOKEN=…            # from Settings → Local API
curl -s $MMF/health -H "Authorization: Bearer $TOKEN"
```

## Authentication

Every request, `GET /health` included, needs

```
Authorization: Bearer <token>
```

A missing or wrong token is a `401` with `WWW-Authenticate: Bearer realm="mmf"`. Only the caller's
address is checked before the token. The route and body come after, so an unauthenticated caller can't
find out which routes exist. The comparison is done
in constant time over SHA-256 digests, so response timing doesn't leak how much of a guess was right.

The token lives in this vault's plugin `data.json` in plain text, like the AI key and the delivery
credentials. The settings panel says so. It is **never logged**: a request that fails is logged under
`[mmf/api]` with its method, path and a request id, never its headers or body. **Regenerate** in
settings issues a new token and drops every open connection, so a client still holding the old one is
cut off at once rather than on its next connect.

## Who can connect

| Listen on | Binds to | Who can reach it |
|---|---|---|
| This computer only (default) | `127.0.0.1` | programs on this computer |
| Tailscale | this computer's tailnet address (`100.64.0.0/10`) only | devices signed in to your tailnet |

"Tailscale" never binds `0.0.0.0` and never your Wi-Fi or LAN address. Without a Tailscale address the
plugin falls back to `127.0.0.1` and says so in a notice. As a second line of defence, a request from
any address other than loopback (or, in Tailscale mode, a tailnet address) is refused with `403 Client
not allowed`, even if a misconfiguration ever let it reach the socket.

### Allow writes from other devices

Off by default. While it is off, a request from another device may **read** (`GET`, `HEAD`) but
anything else is refused with `403` before any handler runs or any body is read:

```json
{ "error": "Writes from other devices are turned off (Settings → Local API → Allow writes from other devices)" }
```

"Another device" means anything that didn't come from this computer's loopback, **or** came through a
proxy. A request carrying `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or `Tailscale-User-Login` counts
as remote even though `tailscale serve` relays it from `127.0.0.1`.

`POST /reports/generate` is a `POST`, so with this switch off a phone can't generate reports either. It
takes a body and can write a note into the vault, and the switch takes the safe reading.

## Ideas you need

- **Ids** are the plugin's own (`acc-…`, `cat-…`, `rule-…`, transaction ids from the import). A
  merchant's id is its normalised key (`"grocer brothers"`). URL-encode it, since keys contain spaces.
- **Amounts are signed**: negative is money out, positive money in, in the transaction's own `currency`.
  Report totals are converted to your base currency.
- **Dates** are `YYYY-MM-DD`, and must be real days: `2024-02-30` is a `400`, not 1 March.
- **`PATCH` sends only what changes.** A key you leave out is left alone; `null` clears an optional field
  (it is removed from the record, not stored as null); a key the resource doesn't have is a `400`, so a
  typo like `categoryID` can't be silently ignored and reported as success.
- **`POST` that creates something replies `201`** with the new record.
- **Every write replies with `written`**: the vault-relative paths the call wrote or removed, in the order
  it first touched them. It is `[]` for a dry run or a write that turned out to change nothing.
- **Bulk writes** reply `{ applied, changed, failed: [{ ref, error }], written }`. A missing id fails on
  its own; the rest still apply.
- **The revision.** Every authenticated response carries `x-mmf-revision`, and `GET /health` the same
  `revision`: a number that goes up whenever the plugin writes a data file or reloads (switching
  portfolio included), whether the change came from the API or from the app. Poll it, and re-read only
  when it moves. It restarts at 0 each time the plugin loads, so compare it for equality only.
- **Portfolios.** The API always serves the active portfolio and follows a switch at once. `GET /health`
  names the portfolio, so check it before writing.

## Headers

| header | on | meaning |
|---|---|---|
| `Authorization: Bearer <token>` | every request | see [Authentication](#authentication) |
| `Content-Type: application/json` | requests with a body | the only body format read; the body limit is 1 MB |
| `Content-Type: application/json; charset=utf-8` | every response with a body | |
| `x-mmf-revision` | every authenticated response, errors included | see [the revision](#ideas-you-need) |
| `Cache-Control: no-store` | every response | nothing here is worth caching |
| `X-Content-Type-Options: nosniff` | every response | |
| `WWW-Authenticate: Bearer realm="mmf"` | `401` | |
| `Allow` | `405` | the methods the path does take |

`HEAD` works wherever `GET` does.

## Errors

Every error is JSON with one field, `{ "error": "…" }`, and the message says what to fix.

| code | meaning |
|---|---|
| 400 | the request is wrong: unknown field, wrong type, bad date, an id that doesn't exist in a body |
| 401 | missing or wrong token |
| 403 | the client isn't allowed to connect, or it's a write from another device while those are off |
| 404 | no such record, or no such route |
| 405 | the path exists but not for that method (`Allow` lists the ones it takes) |
| 409 | a delete that needs you to say what happens to the rows that use the record (`?transactions=` / `?moveTo=`) |
| 413 | body over 1 MB |
| 500 | the plugin threw. The body is `{ "error": "Internal error", "requestId": "…" }`; the details are in Obsidian's developer console under `[mmf/api]` with that id |
| 503 | the finance data isn't loaded yet (the plugin is still starting) |

## Routes

All examples use synthetic data.

### Health

#### `GET /health`

"Is it up, and is it the vault I think it is?"

```json
{
  "ok": true, "version": "1.2.12", "ready": true, "api": 1, "revision": 17,
  "counts": { "accounts": 3, "categories": 5, "rules": 0, "transactions": 10, "reviewNew": 7 },
  "portfolio": { "id": "pf-home", "name": "Household" },
  "dataFolder": "Finance"
}
```

### Accounts

#### `GET /accounts`

`{ "accounts": [ … ] }`, in the order the sidebar lists them.

#### `GET /accounts/:id`

```json
{ "id": "acc-chk", "name": "Checking", "type": "debit", "currency": "EUR" }
```

#### `POST /accounts`

```json
{ "name": "Savings", "type": "saving", "currency": "EUR", "institution": "Example Bank",
  "openingBalance": 1000, "openingDate": "2024-01-01" }
```

Only `name` is required. `type` defaults to `debit`, `currency` to the portfolio's base currency. Other
fields: `iban`, `creditLimit`, `statementDay`, `paymentDueDay` (1–31), `apr`, `minPaymentPct` (0–1),
`archived`, `trackBalance`. `type` is one of `debit`, `credit`, `investing`, `saving`, `cash`, `crypto`,
`property`, `pension`, `loan`, `mortgage`. Replies `201`:

```json
{ "account": { "id": "acc-1713173400000-329x0", "name": "Savings", "type": "saving", "currency": "EUR" },
  "written": ["Finance/data/accounts.json"] }
```

#### `PATCH /accounts/:id`

Changed fields only; `null` clears an optional one. **Closing** an account is `{ "archived": true }`. It
keeps every transaction, balance and report and only leaves the pickers. Replies `{ account, written }`.

#### `DELETE /accounts/:id`

What Manage accounts → remove does: recorded balances and linked cards go with the account; subscriptions
and debts that point at it are kept with the link cleared. An account that still has transactions is a
`409` until you say what happens to them:

| query | what it does |
|---|---|
| `?transactions=delete` | removes them from the ledger with the account |
| `?transactions=keep` | leaves them in the ledger with no account |

```json
{ "deleted": "acc-old", "removed": { "transactions": 0, "snapshots": 1, "cards": 0 },
  "cleared": { "subscriptions": 1, "debts": 0 }, "keptTransactions": 12, "written": [ … ] }
```

### Categories

Two levels: primaries, and secondaries that carry the `parentId` of the primary they sit under.

#### `GET /categories`

`{ "categories": [ … ] }`, primaries and secondaries in one flat list.

#### `GET /categories/:id`

```json
{ "id": "cat-food-super", "name": "Supermarket", "color": "#888888", "icon": "tag", "aliases": [],
  "parentId": "cat-food" }
```

#### `POST /categories`

```json
{ "name": "Bakery", "parentId": "cat-food" }
```

Only `name` is required. A secondary takes its parent's colour and icon unless given its own. Other
fields: `color`, `icon`, `aliases`, `archived`, `budgetMode` (`total` or `breakdown`, primaries only),
`kind` (`expense` or `income`), `essential`, `budgetHistory` (`{ "2024-03": 400 }`), `annualBudgets`
(`{ "2024": 1200 }`). The parent has to be a primary. Replies `201 { category, written }`.

#### `PATCH /categories/:id`

Changed fields only. `parentId` moves the category (`null` makes it a primary) when the app's own
dropdown would allow it. A primary with subcategories can't become one. `{ "archived": true }` hides a
category, and a primary's subcategories with it, from budgets and pickers while every transaction keeps
it. Replies `{ category, written }`.

#### `DELETE /categories/:id`

A primary goes together with its subcategories. If any transaction uses them, it's a `409` until you
say where the rows go:

| query | what it does |
|---|---|
| `?moveTo=<categoryId>` | files them under that category |
| `?moveTo=none` | leaves them uncategorized |

```json
{ "error": "2 transactions are tagged with \"Fun\" — add ?moveTo=<categoryId> to move them, or ?moveTo=none to leave them uncategorized" }
```

```json
{ "deleted": "cat-fun", "deletedSubcategories": [], "transactions": { "affected": 2, "movedTo": null },
  "written": [ … ] }
```

### Rules

Tried in order; the first match wins.

#### `GET /rules`

`{ "rules": [ … ] }`, in the order they are tried.

#### `GET /rules/:id`

The rule.

#### `POST /rules`

```json
{ "pattern": "GROCER BROTHERS", "categoryId": "cat-food-super", "match": "starts-with",
  "amount": { "op": "any-of", "values": [9.99, 2.99] } }
```

`pattern` and `categoryId` are required. `match` is `contains` (default), `exact`, `starts-with` or
`regex`. A regex has to compile, and one that nests a repeat inside a repeat (`(a+)+`) is refused. `amount`
narrows by the absolute amount: `{ op: "exactly" | "at-most" | "at-least", value }`,
`{ op: "between", value, value2 }` or `{ op: "any-of", values }`. A new rule goes **first**, as the rule
dialog puts it. Replies `201 { rule, written }`.

Saving a rule doesn't re-file the ledger. Rules run on every import, and applying one to existing rows,
with a preview of what moves, is the rule dialog's job.

#### `PATCH /rules/:id`

Changed fields only; `"amount": null` drops the amount condition. If the scope changes, rows still
stamped as filed by this rule that it no longer matches lose the stamp (never their category). Replies
`{ rule, unstamped, written }`.

#### `DELETE /rules/:id`

`{ "deleted": "rule-…", "written": [ … ] }`.

### Merchant memory

What the portfolio has learned about which category each merchant belongs to. A category set here is
recorded as your own decision (`source: "user"`), the strongest kind: a rule or AI answer never
overwrites it. It changes what the next import does, not the ledger.

#### `GET /merchants`

`{ "merchants": [ … ] }`, by key.

#### `GET /merchants/:key`

```json
{ "key": "grocer brothers", "categoryId": "cat-food-super", "source": "user", "at": "2024-04-15" }
```

#### `POST /merchants`

`{ "key": "grocer brothers", "categoryId": "cat-food-super" }`, or, when you hold a bank line rather than
a key, `{ "description": "GROCER BROTHERS 0012", "counterparty": "…", "categoryId": "…" }` and the key is
worked out the way an import would. Replies `201` when the merchant was new, `200` when it was updated:
`{ merchant, written }`.

#### `PATCH /merchants/:key`

`{ "categoryId": "cat-food" }` files it (`null` takes the category away); `{ "reviewed": true }` records
that a person has checked it (`false`/`null` withdraws that). Replies `{ merchant, written }`.

#### `POST /merchants/:key/dismiss`

No body. Rejects a parked AI suggestion without choosing a category, and remembers that, so the same guess
isn't offered again. Replies `{ merchant, written }`.

#### `DELETE /merchants/:key`

Forgets the merchant. `{ "deleted": "grocer brothers", "written": [ … ] }`.

```bash
curl -s "$MMF/merchants/grocer%20brothers" -H "Authorization: Bearer $TOKEN"
```

### Transactions

#### `GET /transactions`

Newest first, paged. Query parameters, all optional:

| parameter | meaning |
|---|---|
| `account` | account id |
| `from`, `to` | inclusive dates; a date bound leaves out rows with no date |
| `category` | category id; a primary matches its subcategories too |
| `uncategorised` | `true`: only rows without a category; `false`: only rows with one |
| `q` | text in the description, counterparty or notes |
| `review` | `new`, `approved`, `flagged`, comma-separated or repeated |
| `limit` | default 200, max 1000 |
| `offset` | default 0 |

```json
{ "items": [
    { "id": "t-08", "date": "2024-03-20", "accountId": "acc-chk", "description": "GROCER BROTHERS 0056",
      "amount": -8.75, "currency": "EUR", "source": "generic", "categoryId": "cat-food",
      "categoryRuleId": "rule-grocer", "importBatchId": "batch-1713173400000-ihte1" },
    { "id": "t-09", "date": "2024-03-20", "accountId": "acc-cc", "description": "Paper store",
      "amount": -15, "currency": "EUR", "source": "generic", "counterparty": "Stationery World" } ],
  "total": 10, "nextOffset": 2 }
```

`nextOffset` is `null` on the last page.

#### `GET /transactions/:id`

The transaction.

#### `PATCH /transactions/:id`

The Review page's edit surface, not the edit modal's: `categoryId`, `notes`, and on a payment into a
loan, mortgage or credit card the split `principalAmount`, `interestAmount`, `feeAmount` (zero or more,
not adding up to more than the amount). Date, amount, account and description stay with the app, because
they decide which ledger file a row lives in and how later imports dedupe against it.

```json
{ "categoryId": "cat-food-super", "notes": "Weekly shop" }
```

Setting a category is also a lesson, as it is in the app: merchant memory learns it, and blank rows from
the same merchant follow. `alsoCategorised` says how many did.

```json
{ "transaction": { "id": "t-01", "date": "2024-01-05", "accountId": "acc-chk",
    "description": "GROCER BROTHERS 0012", "amount": -40.1, "currency": "EUR", "source": "generic",
    "notes": "Weekly shop", "categoryId": "cat-food-super" },
  "alsoCategorised": 1,
  "written": ["Finance/data/ledger/generic/2024.csv", "Finance/data/merchants.json"] }
```

### Review

#### `GET /review`

The queue: rows still `new` or `flagged`, with the same filters and paging as `GET /transactions`.
`review` may narrow it to one pile; approved rows are `GET /transactions?review=approved`. `counts`
covers the account when one is asked for, and the whole ledger otherwise.

```json
{ "items": [ … ], "total": 8, "nextOffset": 1,
  "counts": { "total": 10, "toReview": 7, "approved": 2, "flagged": 1, "uncategorized": 4 } }
```

#### `POST /review/approve`

`{ "ids": ["t-02", "t-nope"] }`, the Review page's bulk approve, merchant confirmation included.

```json
{ "applied": 1, "changed": 1, "failed": [{ "ref": "t-nope", "error": "Transaction not found" }],
  "written": ["Finance/data/ledger/generic/2024.csv"] }
```

#### `POST /review/recategorise`

`{ "ids": ["t-09"], "categoryId": "cat-fun" }`: file and approve in one, the common case when working
down the queue. Merchant memory learns the category. Same reply shape as approve.

### Import

#### `POST /import`

A bank export, base64-encoded inside the JSON body:

```json
{ "fileName": "example.csv", "contentBase64": "RGF0ZSxEZXNjcmlwdGlvbixBbW91bnQK…", "accountId": "acc-chk",
  "format": "csv", "mapping": { "date": "Date" }, "dryRun": true }
```

`fileName`, `contentBase64` and `accountId` are required. `format` is `camt053`, `mt940`, `ofx`, `qif`,
`xlsx` or `csv`; left out, the content decides, as it does for a dropped file. `mapping` is laid over the
suggested column mapping. `dryRun` runs every step, writes nothing and returns `preview`.

```json
{ "dryRun": false, "fileName": "example.csv", "format": "Unrecognized", "formats": ["unknown"],
  "mapping": { "date": "Date", "description": "Description", "amount": "Amount", … },
  "parsed": 2, "repeated": 0, "categorised": { "file": 0, "memory": 0, "rules": 0 }, "uncategorised": 2,
  "batchId": "batch-1713173400000-xbjwm", "imported": 2, "duplicates": 0,
  "written": ["Finance/data/ledger/generic/2024.csv", "Finance/data/import-batches.json"] }
```

`201` when rows were written; `200` with `"batchId": null` when every row was already in the ledger, and
for a dry run. The 1 MB body limit is roughly 750 KB of file. Split a bigger export by date range;
duplicates make overlapping ranges harmless.

#### `GET /imports`

Every import run, newest first, with how many of its rows remain:

```json
{ "imports": [ { "id": "batch-1713173400000-xbjwm", "importedAt": "2024-04-15T09:30:00.000Z",
    "source": "generic", "fileName": "example.csv", "format": "Unrecognized", "count": 2, "remaining": 2 } ] }
```

#### `GET /imports/:batchId`

One run, plus `transactions`: the rows it brought in that are still in the ledger.

#### `POST /imports/:batchId/undo`

Settings → Import history → Undo import: deletes every row the run created (including rows edited since)
and forgets the run. `{ "batchId": "…", "removed": 2, "written": [ … ] }`.

### Reports

#### `GET /reports`

What can be generated:

```json
{ "types": [
    { "type": "monthly", "description": "One month as a note: …", "period": "YYYY-MM — defaults to this month", "formats": ["markdown"] },
    { "type": "yearly", "description": "One year as a note: …", "period": "YYYY — defaults to this year", "formats": ["markdown"] },
    { "type": "net-worth", "description": "Net worth today, …", "period": null, "formats": ["markdown"] },
    { "type": "custom", "description": "Any slice of the ledger — …", "period": null, "formats": ["markdown", "csv", "xml", "html"] } ],
  "formats": [
    { "format": "markdown", "extension": "md", "contentType": "text/markdown; charset=utf-8" },
    { "format": "csv", "extension": "csv", "contentType": "text/csv; charset=utf-8" },
    { "format": "xml", "extension": "xls", "contentType": "application/vnd.ms-excel" },
    { "format": "html", "extension": "html", "contentType": "text/html; charset=utf-8" } ],
  "queryFields": ["from", "to", "categoryIds", "excludeCategoryIds", "accountIds", "search", "measure", "direction", "includeTransfers"] }
```

#### `POST /reports/generate`

```json
{ "type": "custom", "format": "csv", "title": "Groceries 2024",
  "query": { "from": "2024-01-01", "to": "2024-12-31", "categoryIds": ["cat-food"], "direction": "out" } }
```

| field | meaning |
|---|---|
| `type` | required: `monthly`, `yearly`, `net-worth` or `custom` |
| `period` | `monthly`: `YYYY-MM`, `yearly`: `YYYY`. Defaults to this month / this year. Not for the other two |
| `query` | `custom` only. Any of the `queryFields` above; empty or left out means the whole ledger |
| `title` | `custom` only. Defaults to a description of the query ("Food · 2024"), and names the file |
| `format` | `markdown` (default), or for `custom` also `csv`, `xml` (SpreadsheetML, saved as `.xls`), `html` |
| `write` | `true` also saves the report as a note. `markdown` only |

The `monthly`, `yearly` and `net-worth` reports are the notes the **Write this month's report** commands
write. `custom` is the Reports page: in `query`, a primary category pulls in its subcategories,
`"__uncategorized"` selects rows without one, `measure` is `economic` (default; refunds net against
purchases, transfers aren't spending) or `cash-flow`, `direction` is `all`, `out` or `in`, and
`includeTransfers` brings transfers, trades and debt-principal payments back in. An id in `query` that
doesn't exist is a `400`, so a typo can't come back as "you spent €0".

The report comes back **inline**, in `content`. `fileName` and `contentType` say how to save it. A
custom report adds `summary`, its totals in base currency and in cents:

```json
{ "type": "custom", "format": "csv", "period": "2024", "title": "Food · 2024", "fileName": "Food - 2024.csv",
  "contentType": "text/csv; charset=utf-8",
  "content": "﻿Date,Description,Counterparty,Account,Category,Subcategory,Amount,Currency,Notes\n2024-03-20,GROCER BROTHERS 0056,,Checking,Food,,-8.75,EUR,\n…",
  "summary": { "count": 4, "spent": 64.55, "received": 0, "net": -64.55, "largest": 40.1, "months": 3,
    "baseCurrency": "EUR", "mixedCurrencies": [] },
  "written": [] }
```

The CSV is byte-for-byte the file the Reports page's CSV button saves: it starts with a UTF-8 BOM so
Excel reads accents correctly, and uses the **CSV column separator** set on the workspace's Settings page →
Reports. HTML is the document the
PDF export prints, without receipts. A markdown custom report embeds receipts by link, as **Write note**
does.

With `"write": true` the note is saved under `<data folder>/reports/`, with the same writer and name the
app uses (`2024-02.md`, `2024.md`, `Net worth.md`, or the custom title), so it **replaces** that note
rather than adding a copy:

```json
{ "type": "monthly", "format": "markdown", "period": "2024-02", "fileName": "2024-02.md",
  "contentType": "text/markdown; charset=utf-8",
  "content": "---\ntype: finance-report\nperiod: month\nmonth: 2024-02\n…",
  "written": ["Finance/reports/2024-02.md"] }
```

A report note isn't finance data, so writing one doesn't move `x-mmf-revision`. Generating always replies
`200`.

## A worked example

```bash
# what's still waiting for a decision?
curl -s "$MMF/review?limit=20" -H "Authorization: Bearer $TOKEN"

# file the paper shop under Fun and approve it in one go
curl -s -X POST $MMF/review/recategorise -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"ids":["t-09"],"categoryId":"cat-fun"}'

# everything spent on food this year, as a spreadsheet
curl -s -X POST $MMF/reports/generate -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"custom","format":"xml","query":{"from":"2024-01-01","to":"2024-12-31","categoryIds":["cat-food"]}}' \
  | jq -r .content > food-2024.xls

# and last month's report as a note in the vault
curl -s -X POST $MMF/reports/generate -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"monthly","period":"2024-03","write":true}' | jq .written
```

## From your phone (Tailscale)

Anything on another device reaches the API over [Tailscale](https://tailscale.com): a private WireGuard
mesh between your own devices, so nothing is opened to the internet and nothing needs port forwarding.

1. Install Tailscale on the computer running Obsidian and on the phone, signed in to the same tailnet.
2. Settings → **Local API** → **Listen on** → *Tailscale (this computer's 100.x address)*. The plugin finds
   the computer's Tailscale IPv4 (in `100.64.0.0/10`, for example `100.101.102.103`) and binds to that
   address only. If there isn't one, it says so and falls back to `127.0.0.1`.
3. Use `http://100.101.102.103:27128/mmf/v1` and the token on the other device. It can read straight
   away; turn on **Allow writes from other devices** only if it should also change things.

Traffic between the devices is encrypted by WireGuard, and every request still needs the token.

**HTTPS with `tailscale serve`.** Some clients (App Transport Security on iOS, browsers) want TLS. Keep
the API on `127.0.0.1` and let Tailscale terminate HTTPS with a certificate for the computer's tailnet name:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:27128
# → https://<machine>.<tailnet>.ts.net/mmf/v1   (Tailscale prints the exact name)
tailscale serve status
tailscale serve reset     # stop
```

Requests relayed this way carry forwarding headers, so they count as coming from another device and
are read-only unless **Allow writes from other devices** is on. `tailscale serve` is reachable from your
tailnet only. Don't use `tailscale funnel` for this: funnel is public.
