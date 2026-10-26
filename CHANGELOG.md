# Changelog

Notable changes to Manage My Finance. Versions match `manifest.json`.

## Unreleased

### Added

- **Optional local HTTP API** under `/mmf/v1`, **off by default** (Vault settings → Local API). It lets
  scripts, shortcuts and AI agents read and change your finances through the same code the buttons run.
  Full reference with examples: [docs/api.md](docs/api.md).
  - `GET /health`, with a `revision` (also sent as the `x-mmf-revision` header on every response) that
    moves whenever a data file is written or the portfolio reloads, so a client can poll cheaply.
  - Accounts, categories, rules and merchant memory: list, read, create, change (send only what
    changes; `null` clears) and delete, with the same safeguards as the app's dialogs. Deleting an
    account or category that still has transactions asks what to do with them (`409`) rather than
    orphaning them.
  - Transactions: filtered, paged listing, and the Review page's edits (category, notes, debt-payment
    split). Setting a category teaches merchant memory exactly as it does in the app.
  - The review queue: list it, bulk approve, bulk file-and-approve.
  - Import: `POST /import` takes a bank export (base64 in the JSON body), with a dry run, plus import
    history and undo.
  - Reports: monthly, yearly, net worth and custom-query reports as markdown, CSV, Excel (SpreadsheetML)
    or HTML, returned inline. `GET /reports/generate` generates one read-only, including from another
    device while remote writes are off; `POST /reports/generate` with `write: true` also saves it as a note.
  - Every write replies with `written`, the vault files it touched.
- Security: a bearer token on every request (constant-time comparison, never logged); listens on
  `127.0.0.1` only unless Tailscale is chosen, which binds the tailnet address alone; writes from other
  devices are refused unless **Allow writes from other devices** is on, including requests relayed by
  `tailscale serve`; never started on mobile.

### Changed

- The local API's default port is now **27130** (was 27128, which clashed with another local plugin).
  A port you set yourself in Vault settings → Local API is kept.
- The import wizard's pipeline (read, map, parse, de-duplicate, categorize, write) now lives in a
  UI-free module, `src/import/importService.ts`, which the wizard and `POST /import` share. The wizard's
  screens and results are unchanged.

### Fixed

- Undoing an import (or deleting the last transactions of a year) no longer leaves an empty, header-only
  ledger file behind; the year's file is removed instead.
