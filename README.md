# Online Kass

Multi-tenant cash-desk and inventory platform: superadmin panel, shop back office, POS with offline mode,
a local Windows agent for thermal printers / cash drawers / scanners, fiscal receipts, reports, Telegram
notifications, a public REST API and webhooks. Interface languages: Uzbek, Russian, English. Light and dark theme
(follows the system until you press the sun/moon button; the choice is remembered per browser).

Specification: [online-kass-technical-specification.md](online-kass-technical-specification.md)

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Types, Zod schemas, permissions, money/time helpers, promotion engine, i18n (uz/ru/en) shared by every app |
| `apps/api` | Express + Mongoose API, background workers, public API, webhooks, Telegram, reports |
| `apps/web` | Next.js 14 app: `/superadmin`, `/shop` (back office) and `/pos` (cash desk, offline-capable) |
| `apps/agent` | Windows tray agent: ESC/POS printing, drawer, scanner bridge, local WebSocket for the POS |
| `docker/`, `docker-compose.yml` | Production-like container stack (MongoDB replica set, API, web, Nginx) |
| `docs/` | Architecture, deployment, agent packaging, security notes |

## Quick start (no Docker, no installed MongoDB)

Requires Node.js 20+.

```bash
npm install
npm run demo
```

`npm run demo` starts **everything** and loads the full demo data set (about a minute the first time):

| Part | What runs | Where |
| --- | --- | --- |
| Backend | in-memory MongoDB replica set + API + background workers | API <http://localhost:4000/api/v1>, docs `/docs` |
| Frontend | Next.js dev server | <http://localhost:3000> |
| Local agent | the Windows printer agent, auto-paired to "Kassa 1" and printing to `.devdata/printed/receipts.txt` instead of hardware | `ws://127.0.0.1:17890`, settings <http://127.0.0.1:17891> |
| Webhook receiver | prints every webhook the demo shop sends as `[hook]` | port 4010 |

| Command | Does |
| --- | --- |
| `npm run dev` | everything above, without demo data (just the platform owner `root`). Data persists in `.devdata/`. |
| `npm run demo` | the same plus the demo data. Loaded once; running it again starts on the same data. |
| `npm run demo:reset` | wipes `.devdata/` and loads the demo again (stop other runs first). |

Flags: `--no-agent`, `--no-web`, `--verbose` (`npm run dev -- --no-agent`). Ctrl+C stops everything.

### What the demo contains

* **Demo Market** (shop owner `demo.admin`): 2 branches, 3 terminals, 6 staff, a category tree, 48 products with prices per
  branch, 3 suppliers, goods receipts, a transfer with a discrepancy, a write-off, a stock count, supplier payments,
  promotions of every type (percent, fixed, buy-X-get-Y, bundle, happy-hour schedule, an ended one), 14 loyalty
  customers with bonus, credit limits and debts, **31 days of history** (~730 sales, refunds, cash in/out, shifts with
  small cash differences, removed-line logs), low-stock items, a scheduled price change, an API key (printed once in the log)
  and a webhook. Dilnoza's shift is open on Kassa 2 with today's sales; **Kassa 1 is free for you to open a shift**.
* **Chaikhona Fiscal** (`fiscal.admin`): a fiscal shop on the mock fiscal module with a week of fiscalized sales.
* Shops in other states for the platform owner: trial ending soon, expired, blocked; payment history for Demo Market.

| Login | Password | Role / lands on |
| --- | --- | --- |
| `admin` | `a@a@admina@a@` | platform owner → `/superadmin` |
| `demo.admin` | `demo12345` | shop owner → `/shop` |
| `demo.manager` | `demo12345` (PIN 9999) | branch manager → `/shop` |
| `demo.store` | `demo12345` | storekeeper → `/shop` |
| `demo.cashier` | `demo12345` (PIN 1234) | cashier, Kassa 1 → `/pos` |
| `dilnoza` | `demo12345` (PIN 2222) | cashier, Kassa 2 (open shift, may sell on credit) |
| `jasur` | `demo12345` (PIN 3333) | cashier of the Yunusobod branch |
| `fiscal.admin`, `fiscal.cashier` | `demo12345` | fiscal shop |
| `trial.admin`, `bakery.admin`, `kiosk.admin` | `demo12345` | trial / expired / blocked shops |

Try the POS as `demo.cashier`: open a shift, scan or type a barcode, pay with F9/F12 and read the printout in
`.devdata/printed/receipts.txt`. Switch the browser offline (or stop the API) to see offline selling and the sync.
The demo history is created through the public API and then moved back in time by `apps/api/src/scripts/seed-demo.ts`
(a development-only tool: it needs direct database access).

### Warehouse: the simple "Ombor" is on, the full warehouse is off

Products are sold without counting quantities; profit is selling price − the product's cost price ("Tannarx").
**Ombor** (`/shop/warehouse`) records goods that arrived: existing products, quantity, cost per unit and an optional
supplier / delivery person from **Yetkazib beruvchilar** (`/shop/suppliers`). It can also update the products' cost price, and it shows
statistics (by day, product and supplier; API `GET /goods-receipts/stats`). Arrivals can be cancelled. The full warehouse
(stock balances, transfers, write-offs, counts, stock alerts and stock checks of a sale) stays hidden; movements are still recorded
in the background. To bring it back, set `KASS_INVENTORY=true` (API) and `NEXT_PUBLIC_INVENTORY=true` (web).

### Cash desk program (Python)

Platform owner → Shops → a shop → **Programs** downloads `kassa_desk_<terminal>.py` for one terminal: a window
program (standard library only) that reads a 2D/1D scanner on a USB COM port (or in keyboard mode), shows the
receipt and total, saves each sale through `/api/v1/desk/*`, prints ESC/POS receipts, and keeps selling offline in
non-fiscal shops. It has no shift buttons: the server opens one shift per day for that register on the first sale and
closes it automatically the next day (cash counted = expected). The file carries its own key (revocable on the same tab). Build an .exe with
`pyinstaller --onefile --noconsole --name OnlineKassDesk kassa_desk_<terminal>.py`. Template:
`apps/api/assets/programs/kassa_desk.py`.

## Scripts

```bash
npm run typecheck   # all workspaces
npm test            # shared, api (in-memory MongoDB), agent, web
npm run lint
npm run test:e2e -w @kass/web   # Playwright: shop setup, sale, offline sale + sync, return, close shift
# against another stack (keeps your demo data clean): E2E_WEB_URL=http://localhost:3010 E2E_API_URL=http://localhost:4078/api/v1
# (a second `next dev` for it needs NEXT_DIST_DIR=.next-e2e so it does not share the .next folder)
npm run build
```

## Production

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: `cp .env.example .env`, set the secrets,
`docker compose up -d --build`, then `docker compose exec api node dist/scripts/seed-superadmin.js`.

## Key design rules

* **Tenant isolation**: every shop-owned collection carries `shopId`; repositories force it from the
  session and a Mongoose plugin throws on any query that lacks it.
* **Money is integers** in minor units; **time is UTC** in the database and shown in Asia/Tashkent.
* **Stock is a ledger**: quantity is the sum of append-only movements; every change runs in a transaction.
* **The server is authoritative** for prices, promotions and discounts; the POS recomputes only for display
  and for offline sales (which keep the price the customer was charged and record conflicts).
* **Permissions**: role defaults + per-user extras; selling prices can be changed by the shop owner only.

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
"# online-kassa" 
