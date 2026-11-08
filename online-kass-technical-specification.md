# Online Kass — Technical Specification

Version: 2.0 (full version) · Date: 6 November 2026

Online Kass is a multi-tenant cash desk (POS) and inventory platform. One superadmin creates and manages shops; each shop works in its own isolated workspace with branches, branch stock, cashiers, suppliers, customers, statistics and an API documentation page, and connects its barcode scanners and receipt printers through a local agent.

---

## 1. General information

### 1.1 Purpose

- Automate sales at the cash desk: barcode scanning, receipt printing, payments, returns and shift reports.
- Give each shop owner full control of catalog, per-branch prices, stock, suppliers, customers and staff.
- Give the platform owner (superadmin) one place to onboard shops, record their payments, enable fiscal receipts per shop, and block or activate shops.

### 1.2 Scope

This document describes the full version of the product. It is delivered in development stages (section 15), but every feature below belongs to the final product.

Included: superadmin panel; shop admin panel; POS cashier workstation with offline mode; cashier accounts and shifts; multiple branches, each with its own stock; supplier purchases, stock receiving and returns; customers, loyalty and customer debts; promotions; fiscal receipt integration (enabled per shop by the superadmin); statistics and reports; Telegram notifications; per-shop API documentation page and public API; local agent for scanner and printer; interface in Uzbek, Russian and English.

Out of scope: online payment gateways (for example Click, Payme), mobile applications, an online store. These can be connected later through the public API (section 10).

### 1.3 Decisions

| Topic | Decision |
| --- | --- |
| Project name | Online Kass |
| Domain | Not chosen yet; the system must work on any domain set in configuration |
| Interface languages | Uzbek (Latin), Russian, English; each user chooses their language |
| Currency | Chosen by the shop; options UZS, USD, RUB; default UZS |
| Time zone | Fixed: Asia/Tashkent (UTC+5) for all shops; no time zone setting |
| Selling prices | Set only by the shop owner (shop admin), separately for every product in every branch |
| Stock | Each branch keeps its own stock; no central warehouse |
| Negative stock | Allowed by default (sale proceeds with a warning); the shop admin can switch it off |
| Fiscal receipts | Enabled or disabled per shop by the superadmin when creating or editing the shop |
| Test hardware | Netum A5 2D barcode scanner; Xprinter XP-58IIL 58 mm thermal receipt printer |

### 1.4 Technology stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Frontend | Next.js (App Router), TypeScript | Superadmin panel, shop panel, POS screen, API docs page |
| UI | Tailwind CSS + component library (e.g. shadcn/ui) | Responsive; POS optimized for touchscreen and keyboard |
| Internationalization | next-intl (or similar) | Uzbek, Russian, English message files |
| Backend | Node.js, Express.js, TypeScript | REST API under `/api/v1` |
| Database | MongoDB (replica set), Mongoose | Replica set required for multi-document transactions |
| Real time | WebSocket (Socket.IO or ws) | Agent status, live dashboards |
| Offline storage (POS) | IndexedDB in the browser | Cached catalog and queued sales |
| Local agent | Node.js, packaged as a Windows tray application | Scanner and ESC/POS printer |
| Validation | Zod, shared between frontend and backend | |
| API docs | OpenAPI 3, rendered with Swagger UI or Redoc | |
| Notifications | Telegram Bot API | Owner notifications |
| Deployment | Docker, Nginx, Linux VPS | Section 14 |

### 1.5 Glossary

| Term | Meaning |
| --- | --- |
| Superadmin | Owner of the platform; manages all shops |
| Shop (tenant) | A business registered on the platform; its data is isolated from other shops |
| Branch | A physical store of a shop; each branch has its own stock and its own prices |
| Terminal (cash desk) | A registered POS workstation in a branch, paired with one local agent |
| Shift | A cashier's working session at a terminal, from opening cash to closing count |
| Receipt (sale) | One completed sale |
| Local agent | Program on the cash desk PC that connects the scanner and printer to the web POS |
| Goods receipt | Document recording stock arriving from a supplier |
| X-report / Z-report | Interim shift report / final shift closing report |
| MXIK (IKPU) code | Product classification code required on fiscal receipts |
| Fiscal module | Provider or device through which receipts are registered with the tax authority |

---

## 2. User roles and permissions

There are five roles. Every user except the superadmin belongs to exactly one shop and can never see or log in to another shop's data.

| Role | Created by | Scope | Description |
| --- | --- | --- | --- |
| Superadmin | Seed command at deployment | Whole platform | Creates, edits, blocks and activates shops; records payments; enables fiscal receipts |
| Shop admin (owner) | Superadmin, when creating the shop | Whole shop | Full control: catalog, prices, staff, stock, suppliers, customers, reports, API keys, terminals |
| Branch manager | Shop admin | Assigned branches | Stock documents, cashiers' shifts and reports of assigned branches |
| Storekeeper | Shop admin | Assigned branches | Goods receipts, transfers, write-offs, stock counts |
| Cashier | Shop admin or branch manager | Assigned branch and terminals | POS only: shifts, sales, returns if permitted |

### 2.1 Permissions matrix

| Action | Superadmin | Shop admin | Branch manager | Storekeeper | Cashier |
| --- | --- | --- | --- | --- | --- |
| Create, edit, block shops; enable fiscal receipts | Yes | No | No | No | No |
| Record shop payments | Yes | No | No | No | No |
| Shop settings (currency, negative stock, receipt texts) | No | Yes | No | No | No |
| Manage branches and terminals | No | Yes | No | No | No |
| Manage staff | No | Yes | Cashiers of own branches | No | No |
| Manage products and categories | No | Yes | Optional permission | Optional permission | No |
| Set selling prices | No | Yes (only) | No | No | No |
| Goods receipts, supplier returns | No | Yes | Yes | Yes | No |
| Transfers, write-offs, stock counts | No | Yes | Yes | Yes | No |
| Supplier payments | No | Yes | Optional permission | No | No |
| Customers and customer debts | No | Yes | Yes | No | Create customer, sell on credit if permitted |
| Promotions | No | Yes | No | No | No |
| Open and close shift, sell | No | Optional | Optional | No | Yes |
| Discount above limit | No | Yes | Yes | No | Optional permission |
| Customer returns (refunds) | No | Yes | Yes | No | Optional permission |
| Reports and statistics | Platform totals only | All branches | Own branches | Stock reports only | Own shift report |
| API keys, webhooks, Telegram settings | No | Yes | No | No | No |
| Audit log | Platform log | Shop log | No | No | No |

### 2.2 Rules

- Permissions are stored as permission codes on each user (for example `sales.refund`, `products.edit`), so the shop admin can grant extra rights per employee.
- Selling prices can be changed only by the shop admin; no permission can delegate this right.
- A cashier may have a 4–6 digit PIN for quick switching on an already authorized terminal.
- Blocking a shop blocks all its users, API keys and agents at once.
- A deactivated employee cannot log in; their historical sales and shifts stay in reports.

---

## 3. System architecture

The platform has four parts: a Next.js web app, an Express API, a MongoDB database and a local agent on each cash desk PC. Every request passes authentication and a tenant check before it touches data.

```
 Browsers / external systems          Cash desk PC
 ┌──────────────────────────┐        ┌──────────────────────────────┐
 │ Superadmin panel         │        │ POS screen (browser, /pos)   │
 │ Shop panel + API docs    │        │        ▲ local WebSocket      │
 │ External systems (API)   │        │        ▼ 127.0.0.1            │
 └────────────┬─────────────┘        │ Local agent ── Scanner        │
              │ HTTPS                 │             └─ Printer       │
              │                       └───────┬──────────────┬───────┘
              │                         HTTPS (POS)     WSS (agent)
              ▼                               ▼              ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ Express API: auth + tenancy · REST /api/v1 · WebSocket gateway · │
 │ background workers · fiscal module adapter · Telegram bot        │
 └──────────────────────────────┬───────────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ MongoDB replica set · Redis · Object storage (S3-compatible)     │
 └──────────────────────────────────────────────────────────────────┘
```

### 3.1 Multi-tenancy

- One shared database; every shop-owned document has a `shopId` field, and every compound index starts with `shopId`.
- The repository layer adds the `shopId` filter from the authenticated session to every query and insert; controllers never build tenant filters themselves.
- Logins are unique across the whole platform, so the login identifies the user's shop; the login page has no shop selector.
- The superadmin has no `shopId` and uses separate `/admin` routes; access to a shop's working data is possible only through audited impersonation.

### 3.2 Authentication and sessions

1. `POST /api/v1/auth/login` with login and password.
2. The server checks that the user is active and, for shop users, that the shop is active or in its grace period.
3. The server returns an access token (user ID, role, shop ID, branch IDs, permissions version) and sets a refresh cookie.
4. The frontend redirects by role: superadmin to `/superadmin`; shop admin, branch manager and storekeeper to `/shop`; cashier to `/pos`.
5. Next.js middleware protects route groups by role; the API checks permissions again on every request.

Three credential types exist: user JWT (people), API key (external integrations, section 10) and device token (local agents, section 9).

### 3.3 Frontend structure

- Next.js App Router route groups: `/login`, `/superadmin/*`, `/shop/*` (including `/shop/developers`), `/pos`.
- All business logic stays in the Express API; Next.js renders pages and calls the API (for example with TanStack Query).
- Shared Zod schemas and TypeScript types in a common package keep forms and backend validation identical.

### 3.4 Localization, currency and time

- Interface languages: Uzbek (Latin), Russian, English. The language is chosen on the login page and saved per user; the default is Uzbek.
- All interface texts, validation messages, emails, Telegram messages, receipt labels and report exports are translated. Product names are entered by the shop and are not translated.
- Each shop has one currency: UZS (default), USD or RUB. The shop admin chooses it in shop settings. It can be changed freely until the first posted document or sale; after that it is locked, because amounts are never converted.
- Amounts are stored as integers in minor units (tiyin, cents, kopeks). Display: UZS without decimals and with space thousands separators (`125 000 so'm`), USD and RUB with 2 decimals.
- All times are stored in UTC and shown in Asia/Tashkent (UTC+5, no daylight saving time). A business day runs from 00:00 to 23:59 Tashkent time.

---

## 4. Superadmin panel

The superadmin panel at `/superadmin` covers shop onboarding, manual payment tracking, fiscal settings and platform monitoring.

### 4.1 Dashboard

- Number of shops: total, active, trial, blocked, expiring within 7 days.
- Platform-wide sales volume and receipt count for today, 7 days and 30 days, shown per currency.
- Online agents and terminals.
- Shops whose paid period ends soon or has ended.

### 4.2 Create shop

On submit, the backend creates the shop, its first branch and its admin user in one MongoDB transaction.

| Field | Required | Validation / default |
| --- | --- | --- |
| Shop name | Yes | 2–100 characters |
| Admin full name | Yes | 2–100 characters |
| Admin phone number | Yes | Uzbek format `+998 XX XXX XX XX` by default; stored as E.164 |
| Admin login | Yes | 4–32 characters: Latin letters, digits, dot, underscore; unique across the platform |
| Admin password | Yes | At least 8 characters; stored only as a hash |
| First branch name | Yes | Default "Main branch" |
| Address | No | Free text |
| Tax ID (STIR / INN) | No; required if fiscal receipts are on | 9 digits |
| Currency | Yes | UZS (default), USD, RUB; the shop admin can change it later (section 3.4) |
| Fiscal receipts | Yes | On / Off (default Off); when On, fiscal settings in section 4.4 |
| Interface language of the admin | Yes | Uzbek (default), Russian, English |
| Paid until | No | Empty means trial |
| Limits | No | Maximum branches, terminals, employees (defaults from platform settings) |
| Note | No | Visible only to the superadmin |

Acceptance: the new admin logs in with the given login and password and sees only their own shop; this login can never open another shop or the superadmin panel.

### 4.3 Shop list and details

- Table with search and filters: name, admin, phone, status (active, trial, expired, blocked), fiscal on or off, paid until, branches, created date.
- Details page: profile, admin contacts, limits, fiscal settings, payment history, terminals and agent status, last activity.
- Edit profile, limits and fiscal settings.
- Reset the shop admin's password (new password shown once).
- Change the shop admin.

### 4.4 Fiscal settings per shop

The superadmin decides for each shop whether its receipts are fiscalized.

- Toggle "Fiscal receipts" On or Off, with shop TIN and fiscal module provider credentials (provider, terminal or module ID, API keys) per terminal.
- When On: every sale and refund is sent to the fiscal module before the receipt is printed; the receipt carries the fiscal sign and QR code; products must have an MXIK (IKPU) code and a package unit code.
- When Off: receipts are printed as regular sales receipts without fiscal data.
- Switching Off does not delete fiscal data of earlier receipts.
- The concrete provider integration is implemented behind an adapter interface (section 8.5) so that another provider can be added without changing the POS.

### 4.5 Activation, blocking and payments

Payments are recorded manually; the system does not process money.

- Record a payment: amount, currency, period covered, payment date, method (cash, bank transfer, card, other), comment. Recording a payment extends "paid until".
- Block a shop manually with a reason; unblock manually.
- Automatic expiry: when "paid until" passes, a grace period starts (default 3 days) with a warning banner in the shop panel; then the status becomes "expired" and logins are refused with a message to contact the platform.
- Blocking or expiry revokes active sessions, API keys and agent tokens immediately; data is never deleted.

### 4.6 Support, audit and settings

- "Log in as shop admin" (impersonation) with confirmation, a visible banner, and an audit log entry.
- Platform audit log: shop created, edited, blocked, payment recorded, password reset, fiscal setting changed, impersonation.
- Platform settings: default limits, grace period length, platform name and logo, current local agent installer and version.
- Telegram alerts to the superadmin: shop expiring in 3 days, shop expired, server errors.

---

## 5. Shop admin panel

The shop panel at `/shop` gives the shop admin everything needed to run the business. Branch managers and storekeepers see only the parts and branches their role allows.

### 5.1 Shop settings

- Shop name, address, TIN, logo for receipts.
- Currency: UZS, USD or RUB (rules in section 3.4).
- Negative stock: allowed (default) or blocked.
- Receipt header and footer texts (per branch override possible).
- Receipt language: Uzbek (default), Russian or English.
- Maximum cashier discount without approval (percentage).
- Fiscal status is shown read-only; only the superadmin changes it.

### 5.2 Branches and terminals

- Branch: name, address, phone, working hours, receipt header and footer, status. Limited by the shop's branch limit.
- Each branch has its own stock. There is no central warehouse; goods move between branches only by transfer documents.
- Terminal (cash desk): name, branch, status, linked agent, last seen time, printer profile (paper width, characters per line, code page, cut and drawer commands on or off), fiscal module settings when fiscal receipts are on. Limited by the terminal limit.
- Pairing code generation for a terminal's local agent (section 9.3).

### 5.3 Categories

- Optional; products may exist without a category.
- Tree up to 3 levels, with name in the shop's own wording, sort order and active flag.
- A category with products cannot be deleted; it can be deactivated or its products moved.

### 5.4 Products

| Field | Required | Notes |
| --- | --- | --- |
| Name | Yes | Shown on POS and receipt; up to 2 lines of 32 characters on a 58 mm receipt |
| SKU (article) | No | Unique within the shop |
| Barcodes | No | Several per product; unique within the shop; EAN-13, EAN-8, UPC, Code128, QR, DataMatrix |
| Category | No | |
| Unit | Yes | Piece, kg, gram, litre, metre, pack |
| Sold by weight | No | POS asks for quantity with 3 decimals |
| Purchase cost | No | Calculated from goods receipts (weighted average cost per branch) |
| Selling price per branch | Yes | Set by the shop owner for each branch (section 5.5) |
| VAT rate | No | Percentage; printed on receipt if set |
| MXIK (IKPU) code | Required when fiscal receipts are on | Validated format; searchable reference list |
| Package unit code | Required when fiscal receipts are on | |
| Marked goods | No | If set, POS requires scanning the DataMatrix marking code of each unit |
| Minimum stock | No | Low-stock threshold, per branch |
| Image | No | Up to 2 MB |
| Active | Yes | Inactive products are hidden from POS |

Additional functions:

- Search and filter by name, barcode, SKU, category, stock status, missing price, missing MXIK code.
- Import from Excel or CSV with preview, column mapping and error report; export to Excel. Import can set prices for all branches or for chosen branches.
- Internal barcode generation for products without a factory barcode (prefix 2 + shop code + sequence, EAN-13 with check digit).
- Price label printing (name, price of the selected branch, barcode) as a PDF sheet or through the agent.

### 5.5 Prices

Every selling price of every product is set by the shop owner, separately for each branch.

- Price matrix screen: products as rows, branches as columns; the owner edits cells directly, filters by category and copies prices from one branch to others.
- A new product cannot be sold in a branch until it has a price there; the POS shows "No price in this branch" and the product appears in the "missing price" filter.
- When a new branch is created, the owner chooses: copy prices from an existing branch, or set them later.
- Bulk change by category or selection: percentage or fixed amount, for one or several branches.
- Scheduled price change: new price takes effect at a chosen date and time.
- Price history per product and branch, with user and time.
- Price changes are allowed only for the shop admin and are written to the audit log.

### 5.6 Staff

- Create employee: full name, phone, login, password, role, assigned branches, extra permissions, optional PIN, interface language.
- Edit, deactivate, reset password; limited by the employee limit.
- Activity per employee: shifts, sales total, refunds, discounts, removed lines.

### 5.7 Suppliers

- Supplier card: name, contact person, phone, address, TIN, payment terms in days, note.
- Balance: what the shop owes the supplier (purchases − payments − returns), in the shop currency.
- Supplier payments: amount, date, method, comment; partial payments allowed.
- Supplier statement for a period with opening and closing balance.

### 5.8 Goods receipt (purchase)

1. Choose supplier and branch; enter supplier invoice number and date.
2. Add lines by scanning or searching: product, quantity, purchase cost.
3. An unknown barcode opens a quick "create product" form.
4. Save as draft or post. Posting increases the branch's stock, recalculates weighted average cost, and adds the total to the supplier balance.
5. A posted receipt cannot be edited; it can be cancelled only by a reversing document with a reason.

Purchase costs never change selling prices automatically; the owner can open the price matrix for the received products directly from the posted receipt.

### 5.9 Returns to supplier

- Created from a posted goods receipt or freely: supplier, branch, lines, quantity, cost, reason.
- Posting decreases stock and reduces the supplier balance.

### 5.10 Stock management

- Stock balance per product per branch, valued at average cost and at the branch selling price.
- Every change is a stock movement: goods receipt, sale, customer return, supplier return, transfer out, transfer in, write-off, count adjustment.
- Stock card (movement history with running balance) per product and branch.
- Transfers between branches: created, sent (stock leaves the source), received (stock arrives, with quantity check and discrepancy note).
- Write-offs: damaged, expired, lost, internal use; reason required.
- Stock count: select branch and optional category, scan or enter counted quantities, review differences, post adjustments.
- Negative stock is allowed by default: the POS shows a warning, the sale is saved, the balance goes below zero and the product appears in the "negative stock" report until corrected. If the shop admin blocks negative stock, the sale of that line is refused.
- Low-stock list and Telegram notification when a product falls below its minimum.

---

## 6. Customers, loyalty and promotions

### 6.1 Customers

- Customer card: full name, phone (unique within the shop), optional birthday, note, loyalty card barcode.
- Customer found at the POS by phone, by scanning their card barcode, or by name.
- Purchase history, total spent, average receipt, last visit.

### 6.2 Loyalty

- Shop-level setting: bonus percentage earned from each paid receipt (for example 2%).
- Bonuses can pay part of a receipt, up to a maximum percentage set by the shop.
- Earned and spent bonuses are reversed on refunds.
- Bonus balance printed on the receipt.

### 6.3 Customer debts (sales on credit)

- Sale fully or partly "on credit" to a known customer, if the cashier has the `sales.credit` permission.
- Credit limit per customer (optional).
- Debt repayment at the POS or in the panel, recorded as a cash operation of the shift.
- Debtors report with ageing (0–30, 31–60, over 60 days) and Telegram reminders to the owner.

### 6.4 Promotions

- Types: percentage or fixed discount on products or categories; "buy X get Y"; bundle price; time-based discount (hours and days of week).
- Each promotion has a period, branches, and priority; the POS applies the best eligible promotion automatically and shows it on the receipt.
- Promotions and manual discounts do not stack unless the promotion allows it.

---

## 7. POS cashier workstation

The POS screen at `/pos` runs full screen in the browser (Chrome or Edge) on the cash desk PC. It sells from its branch's stock at its branch's prices and works with the scanner and printer through the local agent.

### 7.1 Login and shift opening

1. The cashier logs in with login and password, or with a PIN on an already authorized terminal.
2. The POS checks that the terminal is paired and the agent and printer are online; if not, it shows what is wrong and how to fix it.
3. If fiscal receipts are on, the POS also checks the fiscal module status.
4. The cashier enters the opening cash amount and the shift opens. One open shift per terminal.

### 7.2 Selling

- Scan a barcode: the product is added to the cart or its quantity increases by 1. Target: under 200 ms.
- Unknown barcode: a distinct sound and message; users with permission can create the product immediately.
- Product without a price in this branch: cannot be sold; message "No price in this branch".
- Search by name or SKU in the interface language of the cashier; quick-access grid of favourite products and categories.
- Weighted products: quantity entered with 3 decimals.
- Marked goods: after the product barcode, the POS asks for the DataMatrix marking code of the unit.
- Edit quantity, remove a line, clear the cart (removals are logged).
- Attach a customer (phone, card barcode or search) for loyalty and credit.
- Promotions applied automatically; manual discounts per line or per receipt, above the cashier's limit only with a manager's PIN.
- Hold (park) a receipt and serve the next customer; restore later.
- Payment methods: cash, card (bank terminal; amount recorded), bonuses, credit, or a combination. For cash the POS calculates change.
- On payment, the sale is saved and stock decreased in one transaction; if fiscal receipts are on, the receipt is fiscalized first (section 8.3); then the receipt is sent to the agent for printing and the cash drawer opens if configured.
- Reprint the last receipt or any receipt of the current shift (marked "Copy").

### 7.3 Receipt content (58 mm, 32 characters per line)

Shop name and logo, branch address and phone, header text, receipt number, date and time (Tashkent), cashier, terminal, lines (name, quantity × price, discount, total), subtotal, discounts and promotions, VAT breakdown if configured, total, payments, cash given and change, customer and bonus balance if attached, footer text, QR code of the receipt number for fast returns. When fiscal receipts are on, also the fiscal sign, fiscal module number, MXIK codes and the fiscal QR code required by the provider.

Receipt labels are printed in the shop's chosen receipt language (Uzbek by default, Russian or English).

### 7.4 Customer returns

- Find the original sale by scanning the receipt QR code or entering its number.
- Select lines and quantities (partial returns allowed, never more than sold minus earlier returns).
- Reason required; refund method cash, card, or reduction of customer debt.
- Requires `sales.refund` or a manager's PIN.
- Returned goods go back to stock (or to write-off if damaged); a return receipt is printed and, when fiscal receipts are on, fiscalized as a refund.

### 7.5 Cash operations and shift closing

- Cash in and cash out during the shift (change money, collection by the owner, debt repayments), with amount and comment.
- X-report: current shift totals without closing.
- Close shift: the cashier counts and enters actual cash; the system shows expected cash (opening + cash sales − cash refunds + cash in − cash out) and the difference.
- Z-report printed and stored: receipts by payment method, returns, discounts, cash operations, expected and counted cash, difference. With fiscal receipts on, the fiscal Z-report is closed through the fiscal module at the same time.
- Shifts open longer than a configurable time (default 24 hours) are flagged and reported to the owner by Telegram.

### 7.6 Offline mode

The POS keeps selling when the internet connection is lost.

- The POS keeps a local copy of its branch's catalog, prices, promotions and customers in IndexedDB, refreshed on login and every few minutes while online.
- Offline sales are stored locally with a unique `clientRequestId` and a local receipt number, and printed through the agent (the agent works without internet).
- When the connection returns, queued sales are sent in order; the server applies them idempotently and decreases stock. Conflicts (for example a price changed meanwhile) keep the price actually charged and are listed in an "offline sync" report.
- Offline limits: refunds, credit sales and bonus payments are disabled offline; a banner shows "Offline" and the number of unsent receipts.
- When fiscal receipts are on, offline selling is allowed only if the configured fiscal module supports offline fiscalization; otherwise the POS blocks sales with a clear message.
- Shift closing requires all queued sales to be sent.

### 7.7 Usability

- Keyboard-only work: F1 search, F2 quantity, F4 discount, F6 customer, F8 hold, F9 payment, F12 close receipt, Esc cancel (configurable).
- Touch friendly: buttons at least 44 px, readable from 60 cm.
- Layout: cart left, totals and payment right, search on top.
- Sounds for successful scan, unknown barcode and error.
- The open cart survives a browser refresh.

---

## 8. Fiscal receipt integration

Fiscal receipts are a per-shop option controlled by the superadmin (section 4.4).

### 8.1 When it applies

- Only for shops with "Fiscal receipts" On; all other shops work without any fiscal step.
- Configured per terminal: each terminal is bound to its fiscal module or provider account.

### 8.2 Product requirements

- MXIK (IKPU) code and package unit code are required for every product sold in a fiscal shop; the POS refuses to sell products without them and the panel lists such products.
- VAT rate per product as required for the receipt.
- Marked goods require the scanned marking code to be passed to the fiscal module.

### 8.3 Sale flow

1. The cashier completes payment in the POS.
2. The backend validates the sale and sends it to the fiscal module through the adapter.
3. The fiscal module returns the fiscal sign, receipt ID and QR code data.
4. The sale is saved with the fiscal data and the stock is decreased.
5. The agent prints the receipt including the fiscal data.

### 8.4 Refunds and shift reports

- Refunds are fiscalized as refund receipts linked to the original fiscal receipt.
- Shift closing also closes the fiscal shift (fiscal Z-report) in the module.

### 8.5 Adapter

- A `FiscalProvider` interface in the backend: `openShift`, `registerSale`, `registerRefund`, `closeShift`, `getStatus`.
- Each supported provider is one implementation; the provider is chosen in the terminal's fiscal settings.
- The provider to implement first is chosen before development of this stage starts; its official API documentation and test credentials are required.

### 8.6 Failures

- If the fiscal module does not answer within a timeout (default 10 s), the sale is not completed, the POS shows the error and offers to retry; money is not taken until the receipt is fiscalized.
- All fiscal requests and responses are logged (without secrets) for audit.

---

## 9. Local agent (scanner and printer)

The local agent is a small Node.js program on each cash desk PC. It prints receipts and labels, forwards scanner input, opens the cash drawer, and reports device status to the server.

### 9.1 Why an agent

- Browsers cannot send ESC/POS commands to a USB thermal printer reliably, cannot open the cash drawer, and show print dialogs.
- Serial scanners and future devices (scales, customer display) need native access.
- USB HID scanners (keyboard mode) also work without the agent; the POS captures their input directly as a fallback.

### 9.2 Platform and packaging

- Windows 10/11, 64-bit.
- Single installer (for example `pkg` + NSIS, or Electron for a settings window); runs as a tray application and starts with Windows.
- Agent interface in Uzbek, Russian and English.
- Auto-update: checks the server on start and every 6 hours.

### 9.3 Pairing

1. In the shop panel the admin opens a terminal and clicks "Pair agent"; a 6-digit code valid for 10 minutes appears.
2. The code is entered in the agent window.
3. The agent sends the code and its machine ID to `POST /api/v1/agent/pair` and receives a long-lived device token bound to that shop and terminal.
4. The token is stored encrypted on the PC; it can be revoked in the panel and is revoked automatically when the shop is blocked.

### 9.4 Connections

- POS page ↔ agent: WebSocket on `ws://127.0.0.1:17890` (port configurable). The agent accepts only the platform's configured origin and requires a short-lived session key that the POS obtains from the server for that terminal.
- Agent ↔ server: outgoing WebSocket over TLS with the device token; heartbeat every 30 s, status, configuration, remote test print, update notices. No inbound ports are opened.
- If the local WebSocket is unavailable while online, print jobs can be routed through the server to the agent.
- Printing and scanning keep working when the internet is down (offline mode, section 7.6).

### 9.5 Message protocol

All messages are JSON with `type`, `id` and `payload`; every request receives an `ack` or `error` with the same `id`.

| Direction | Type | Payload | Purpose |
| --- | --- | --- | --- |
| POS → agent | `hello` | session key, terminal ID | Authenticate the POS page |
| Agent → POS | `status` | printer, scanner, drawer state, agent version | Device status in POS |
| Agent → POS | `scan` | barcode string, symbology, timestamp | Input from serial or HID devices |
| POS → agent | `print.receipt` | structured receipt data, language, copies | Print a receipt |
| POS → agent | `print.label` | name, price, barcode, quantity | Print price labels |
| POS → agent | `print.report` | X- or Z-report data | Print shift reports |
| POS → agent | `drawer.open` | none | Open the cash drawer |
| Agent → POS | `ack` / `error` | request ID, error code, message | Result of a request |
| Agent ↔ server | `heartbeat` | version, devices, uptime | Online status in panels |

### 9.6 Printing (test printer: Xprinter XP-58IIL)

- The agent renders structured receipt data into ESC/POS commands; the POS never sends raw printer bytes.
- Default printer profile for the test printer: 58 mm paper, 384 dots print width, 32 characters per line (font A), USB connection, ESC/POS.
- Character sets: Latin for Uzbek and English; Cyrillic for Russian through code page CP866. Uzbek letters o‘ and g‘ and the sign ʼ are printed with the ASCII apostrophe.
- Logo printed as a raster image; receipt QR code and barcode printed natively or as raster if the model does not support the command.
- Cut and cash drawer commands are sent only if enabled in the terminal's printer profile, because they depend on the model and on whether a drawer is connected.
- Other 58 mm and 80 mm ESC/POS printers (USB, serial, network TCP 9100) are supported through printer profiles.
- Printer selection, profile and test print in the agent window and remotely from the panel.
- Print errors (no paper, offline, cover open) are reported to the POS and can be retried.

### 9.7 Scanning (test scanner: Netum A5, 2D)

- Reads 1D barcodes (EAN, UPC, Code128) and 2D codes (QR for receipt returns, DataMatrix for marked goods and loyalty cards).
- Default mode: USB HID keyboard with Enter suffix and no prefix.
- The POS detects fast keystroke bursts ending with Enter as a scan, even when no input field has focus.
- Scan input is read from physical key codes, so a Russian or Uzbek keyboard layout on the PC does not garble barcodes containing letters.
- For DataMatrix marking codes, the scanner is configured to transmit the group separator character (or a replacement agreed with the POS), because marking codes contain it.
- A short setup guide with the configuration barcodes for the test scanner is part of the API documentation page.

---

## 10. API documentation page and public API

Each shop has an API page at `/shop/developers` that explains how to connect the local agent, scanners, printers and external systems, and lets the shop admin manage API keys. It shows only that shop's own keys and data. The page is available in Uzbek, Russian and English.

### 10.1 Page content

1. Getting started: base URL, authentication, rate limits, response format, error codes.
2. Local agent: download link, version, installation, pairing, troubleshooting (printer not found, wrong characters, port busy).
3. Hardware guides: Xprinter XP-58IIL setup and test print; Netum A5 configuration barcodes (HID mode, Enter suffix, group separator).
4. Device protocol: the WebSocket messages of section 9.5 with JSON examples.
5. Public REST API reference generated from the OpenAPI 3 file (Swagger UI or Redoc).
6. "Try it" console using a selected key of this shop.
7. Webhooks: events and payload examples.
8. API changelog.

### 10.2 API keys

- Create key: name, scopes, optional branch restriction, optional expiry.
- The full key is shown once; stored as a hash with a visible prefix and last 4 characters.
- Revoke key; see last used time and request count.
- Scopes: `products:read`, `products:write`, `prices:read`, `stock:read`, `sales:read`, `sales:write`, `customers:read`, `reports:read`.
- Header: `Authorization: Bearer <api_key>`.
- Rate limit: 120 requests per minute per key by default; remaining quota in response headers.

### 10.3 Public endpoints

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/public/products` | products:read | List products with paging and filters |
| GET | `/api/v1/public/products/by-barcode/{barcode}` | products:read | Find product by barcode (scanners, price checkers) |
| POST | `/api/v1/public/products` | products:write | Create product |
| PATCH | `/api/v1/public/products/{id}` | products:write | Update name, barcodes, category |
| GET | `/api/v1/public/prices?branchId=` | prices:read | Selling prices of a branch |
| GET | `/api/v1/public/stock?branchId=` | stock:read | Stock balance of a branch |
| GET | `/api/v1/public/sales` | sales:read | Receipts for a period |
| GET | `/api/v1/public/sales/{id}` | sales:read | Receipt details |
| POST | `/api/v1/public/sales` | sales:write | Register a sale from an external system |
| GET | `/api/v1/public/customers` | customers:read | Customers and bonus balances |
| GET | `/api/v1/public/reports/daily` | reports:read | Daily totals per branch |

Prices cannot be changed through the public API, because prices are set only by the shop owner in the panel.

### 10.4 Webhooks

- Signed POST requests (HMAC-SHA256 header) to a URL set by the shop admin for events: `sale.created`, `sale.refunded`, `stock.low`, `stock.negative`, `shift.closed`, `goods_receipt.posted`, `price.changed`.
- Retries with exponential backoff for up to 24 hours; delivery log on the page.

---

## 11. Statistics, reports and notifications

All statistics are per shop, filterable by date range and branch, shown in the shop currency and Tashkent time, and exportable to Excel and PDF. The dashboard updates live.

### 11.1 Shop dashboard

- Today versus yesterday and the same day last week: revenue, receipts, average receipt, gross profit.
- Revenue chart by day, week or month.
- Sales by hour and day of week.
- Top 10 products by revenue and by quantity; top categories.
- Payment method split (cash, card, bonuses, credit).
- Branch comparison.
- Open shifts and online terminals; unsent offline receipts.
- Low-stock and negative-stock counts, supplier debt total, customer debt total.

### 11.2 Reports

| Report | Content | Users |
| --- | --- | --- |
| Sales by period | Revenue, receipts, average receipt, discounts, returns, net revenue | Admin, branch manager |
| Sales by product | Quantity, revenue, cost, gross profit, margin % | Admin, branch manager |
| Sales by category | Same, grouped by category | Admin, branch manager |
| Sales by cashier | Receipts, revenue, refunds, discounts, removed lines | Admin, branch manager |
| Shift reports | Shifts with Z-report details and cash differences | Admin, branch manager |
| Returns | Customer returns with reasons, cashier, original receipt | Admin, branch manager |
| Promotions | Revenue and discount amount per promotion | Admin |
| Prices | Current prices per branch, price history, products without price | Admin |
| Stock balance | Quantity and value per product and branch at a chosen date | Admin, manager, storekeeper |
| Stock movement | Opening, incoming, outgoing, closing per product | Admin, manager, storekeeper |
| Negative stock | Products below zero per branch | Admin, manager, storekeeper |
| Slow-moving items | No sales in N days, with stock value | Admin, branch manager |
| Purchases | Goods receipts by supplier, period, product | Admin, storekeeper |
| Supplier balances | Debt per supplier, overdue by payment terms | Admin |
| Customer debts | Debt per customer with ageing | Admin, branch manager |
| Loyalty | Bonuses earned and spent | Admin |
| Profit summary | Revenue − cost of goods sold − write-offs = gross profit | Admin |
| Fiscal receipts | Fiscal and non-fiscalized receipts, errors (fiscal shops only) | Admin |
| Offline sync | Offline sales, sync time, conflicts | Admin |
| Receipt journal | All receipts, searchable by number, cashier, product, customer | Admin, branch manager |

### 11.3 Calculation rules

- Gross profit = net revenue − cost of goods sold; cost is the branch's weighted average cost at the moment of sale, stored on each sale line.
- Net revenue = sales − customer returns; discounts and promotions are already deducted from line totals.
- Sales with negative stock use the last known average cost; the report marks them.
- Heavy reports use MongoDB aggregation with indexes on `shopId`, `branchId`, `createdAt`; daily summaries are pre-computed nightly.

### 11.4 Telegram notifications

- The shop admin links a Telegram account by opening the bot with a one-time link from the panel; several recipients per shop are allowed.
- Notifications (each can be switched on or off): daily summary at a chosen time, shift closed with cash difference, refunds above an amount, low stock, negative stock, open shift over 24 hours, customer debts overdue, shop subscription expiring.
- Messages in the recipient's chosen language.

---

## 12. Data model (MongoDB)

All tenant data lives in one database; every shop-owned document carries `shopId`, added automatically by the data-access layer.

### 12.1 Collections

| Collection | Purpose | Key fields |
| --- | --- | --- |
| `users` | All accounts | `role`, `shopId` (null for superadmin), `fullName`, `phone`, `login` (unique), `passwordHash`, `pinHash`, `branchIds`, `permissions[]`, `language`, `isActive`, `lastLoginAt` |
| `sessions` | Refresh tokens | `userId`, `shopId`, `tokenHash`, `device`, `ip`, `expiresAt`, `revokedAt`, `impersonatedBy` |
| `shops` | Tenants | `name`, `status`, `paidUntil`, `limits`, `currency` (UZS, USD, RUB), `currencyLocked`, `tin`, `fiscalEnabled`, `settings {allowNegativeStock, maxCashierDiscount, receiptLanguage, loyalty}`, `blockReason`, `note` |
| `shopPayments` | Manual payments | `shopId`, `amount`, `currency`, `periodFrom`, `periodTo`, `paidAt`, `method`, `comment`, `createdBy` |
| `branches` | Stores with own stock | `shopId`, `name`, `address`, `phone`, `receiptHeader`, `receiptFooter`, `isActive` |
| `terminals` | Cash desks | `shopId`, `branchId`, `name`, `agentTokenHash`, `agentMachineId`, `agentVersion`, `lastSeenAt`, `printerProfile`, `fiscal {provider, moduleId, credentialsEncrypted}` |
| `categories` | Product tree | `shopId`, `name`, `parentId`, `path`, `sortOrder`, `isActive` |
| `products` | Catalog | `shopId`, `name`, `sku`, `barcodes[]`, `categoryId`, `unit`, `isWeighted`, `vatRate`, `mxikCode`, `packageCode`, `isMarked`, `imageUrl`, `isActive` |
| `prices` | Price per product per branch | `shopId`, `productId`, `branchId`, `price`, `updatedBy`, `updatedAt` (unique per product + branch) |
| `priceChanges` | History and scheduled changes | `shopId`, `productId`, `branchId`, `oldPrice`, `newPrice`, `effectiveAt`, `status`, `userId` |
| `stock` | Current balance | `shopId`, `branchId`, `productId`, `quantity`, `avgCost`, `minStock` (unique per branch + product) |
| `stockMovements` | Ledger | `shopId`, `branchId`, `productId`, `type`, `quantity` (+/−), `unitCost`, `balanceAfter`, `docType`, `docId`, `userId`, `createdAt` |
| `suppliers` | Suppliers | `shopId`, `name`, `contactPerson`, `phone`, `tin`, `paymentTermDays`, `balance` |
| `goodsReceipts` | Purchases | `shopId`, `number`, `supplierId`, `branchId`, `invoiceNo`, `invoiceDate`, `lines[] {productId, qty, cost}`, `total`, `status`, `postedAt`, `createdBy` |
| `supplierReturns` | Returns to supplier | `shopId`, `number`, `supplierId`, `branchId`, `goodsReceiptId`, `lines[]`, `total`, `reason`, `status` |
| `supplierPayments` | Payments to suppliers | `shopId`, `supplierId`, `amount`, `method`, `paidAt`, `comment` |
| `transfers` | Between branches | `shopId`, `number`, `fromBranchId`, `toBranchId`, `lines[] {productId, qtySent, qtyReceived}`, `status` |
| `writeOffs` | Losses | `shopId`, `branchId`, `lines[]`, `reason`, `status` |
| `stockCounts` | Inventory | `shopId`, `branchId`, `lines[] {productId, expected, counted}`, `status` |
| `customers` | Customers | `shopId`, `fullName`, `phone`, `cardBarcode`, `birthday`, `bonusBalance`, `debtBalance`, `creditLimit` |
| `bonusTransactions` | Loyalty ledger | `shopId`, `customerId`, `saleId`, `type`, `amount` |
| `customerPayments` | Debt repayments | `shopId`, `customerId`, `shiftId`, `amount`, `method` |
| `promotions` | Promotions | `shopId`, `name`, `type`, `rules`, `branchIds`, `startsAt`, `endsAt`, `schedule`, `priority`, `isActive` |
| `shifts` | Cashier shifts | `shopId`, `branchId`, `terminalId`, `cashierId`, `openedAt`, `openingCash`, `closedAt`, `countedCash`, `expectedCash`, `totals`, `fiscalShiftId`, `status` |
| `cashOperations` | Cash in / out | `shopId`, `shiftId`, `type`, `amount`, `comment`, `userId` |
| `sales` | Receipts | `shopId`, `branchId`, `terminalId`, `shiftId`, `cashierId`, `customerId`, `number`, `lines[] {productId, name, barcode, markingCode, qty, price, discount, promotionId, total, unitCost, vatRate, mxikCode}`, `subtotal`, `discount`, `total`, `payments[] {method, amount}`, `change`, `currency`, `fiscal {sign, receiptId, qr, status}`, `isOffline`, `syncedAt`, `clientRequestId`, `status`, `createdAt` |
| `refunds` | Customer returns | `shopId`, `saleId`, `shiftId`, `lines[]`, `total`, `method`, `reason`, `approvedBy`, `fiscal` |
| `fiscalLogs` | Fiscal requests | `shopId`, `terminalId`, `docType`, `docId`, `request`, `response`, `status`, `createdAt` |
| `apiKeys` | Integration keys | `shopId`, `name`, `prefix`, `keyHash`, `scopes[]`, `branchId`, `expiresAt`, `lastUsedAt`, `revokedAt` |
| `webhooks` | Webhook endpoints | `shopId`, `url`, `secret`, `events[]`, `isActive` |
| `telegramRecipients` | Bot links | `shopId` (null for superadmin), `userId`, `chatId`, `language`, `notifications {}` |
| `auditLogs` | Audit trail | `shopId`, `userId`, `action`, `entity`, `entityId`, `before`, `after`, `ip`, `createdAt` |
| `counters` | Document numbering | `shopId`, `key`, `seq` |

### 12.2 Data rules

- Money is stored as integers in minor units of the shop currency; floating point is never used for money.
- Sale lines copy name, price, cost and codes at the time of sale.
- A sale, its stock decrease, movements, bonus and debt changes are written in one MongoDB transaction; the same applies to all posted stock documents.
- `clientRequestId` makes sale creation idempotent for retries and offline sync.
- Documents that affect stock or money are cancelled by reversing documents, never physically deleted.

### 12.3 Required indexes

- `users`: `login` unique; `shopId + role`.
- `products`: `shopId + barcodes` unique (multikey); `shopId + sku` unique (sparse); text index on `name`.
- `prices`: `productId + branchId` unique; `shopId + branchId`.
- `stock`: `branchId + productId` unique.
- `stockMovements`: `shopId + productId + createdAt`; `shopId + branchId + createdAt`.
- `sales`: `shopId + createdAt`; `shopId + branchId + createdAt`; `shiftId`; `shopId + number` unique; `clientRequestId` unique.
- `customers`: `shopId + phone` unique; `shopId + cardBarcode` unique (sparse).
- `shifts`: partial unique index on `terminalId` for open shifts.

---

## 13. REST API outline

The internal API used by the Next.js frontend is versioned under `/api/v1`.

### 13.1 Conventions

- Success: `{ "data": ..., "meta": { "page", "limit", "total" } }`; error: `{ "error": { "code": "PRODUCT_NOT_FOUND", "message": "...", "details": [...] } }`.
- Error messages are returned in the user's language (`Accept-Language: uz | ru | en`); error codes stay in English.
- Status codes: 200, 201, 400, 401, 403 (no permission or shop blocked), 404, 409 (duplicate barcode, conflict), 422 (business rule), 429, 500.
- Paging `page` and `limit` (max 100); sorting `sort=-createdAt`; filters as query parameters.
- Dates in ISO 8601 UTC; the frontend shows Tashkent time.
- `shopId` is never accepted from shop users; it comes from the session.

### 13.2 Endpoint groups

| Group | Main endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/pin-login`, `GET /auth/me`, `POST /auth/change-password`, `PATCH /auth/language` |
| Superadmin: shops | `GET/POST /admin/shops`, `GET/PATCH /admin/shops/:id`, `POST /admin/shops/:id/block`, `/unblock`, `/reset-admin-password`, `/impersonate`, `PATCH /admin/shops/:id/fiscal` |
| Superadmin: platform | `GET/POST /admin/shops/:id/payments`, `GET /admin/dashboard`, `GET /admin/audit-logs`, `GET/PATCH /admin/settings` |
| Shop settings | `GET/PATCH /settings` (currency, negative stock, receipt texts, loyalty) |
| Branches, terminals | `/branches`, `/terminals`, `POST /terminals/:id/pairing-code`, `DELETE /terminals/:id/agent` |
| Staff | `/users`, `POST /users/:id/reset-password`, `PATCH /users/:id/status` |
| Catalog | `/categories`, `/products`, `GET /products/by-barcode/:code`, `POST /products/import`, `GET /products/export`, `POST /products/:id/generate-barcode` |
| Prices | `GET /prices?branchId=`, `PUT /prices` (matrix update), `POST /prices/copy`, `POST /prices/bulk`, `/price-changes` (scheduled, history) |
| Suppliers | `/suppliers`, `GET /suppliers/:id/statement`, `/supplier-payments` |
| Stock documents | `/goods-receipts`, `/supplier-returns`, `/transfers`, `/write-offs`, `/stock-counts`, each with `POST /:id/post` and `/:id/cancel` |
| Stock | `GET /stock`, `/stock/movements`, `/stock/low`, `/stock/negative` |
| Customers | `/customers`, `GET /customers/by-phone/:phone`, `/customer-payments`, `GET /customers/:id/history` |
| Promotions | `/promotions` |
| POS | `POST /shifts/open`, `GET /shifts/current`, `POST /shifts/:id/close`, `GET /shifts/:id/x-report`, `POST /cash-operations`, `POST /sales`, `POST /sales/sync` (offline batch), `GET /sales/:id`, `GET /sales/by-number/:number`, `POST /refunds`, `GET /pos/catalog` (branch catalog with prices for offline cache) |
| Fiscal | `GET /fiscal/status/:terminalId`, `GET /fiscal/logs` |
| Reports | `/reports/dashboard`, `/reports/sales`, `/reports/products`, `/reports/categories`, `/reports/cashiers`, `/reports/shifts`, `/reports/returns`, `/reports/promotions`, `/reports/prices`, `/reports/stock`, `/reports/stock-movement`, `/reports/negative-stock`, `/reports/slow-moving`, `/reports/purchases`, `/reports/suppliers`, `/reports/customer-debts`, `/reports/loyalty`, `/reports/profit`, `/reports/fiscal`, `/reports/offline-sync`, each with `format=xlsx|pdf` |
| Developers | `/api-keys`, `/webhooks`, `GET /webhooks/:id/deliveries` |
| Telegram | `POST /telegram/link`, `GET/PATCH /telegram/recipients` |
| Agent | `POST /agent/pair`, `GET /agent/config`, `GET /agent/latest-version`, `POST /pos/agent-session` |
| Audit | `GET /audit-logs` |

### 13.3 Middleware chain (Express)

1. Request ID, logging, language detection.
2. Security headers (helmet), CORS limited to the configured domain, body size limit.
3. Authentication: JWT, API key (`/public`) or device token (`/agent`).
4. Tenant check: shop active or in grace period, otherwise 403 `SHOP_BLOCKED` or `SHOP_EXPIRED`.
5. Permission check against the route's permission code.
6. Branch scope check for branch managers, storekeepers and cashiers.
7. Validation with Zod.
8. Controller → service → repository (repository adds `shopId`).
9. Central error handler; audit logging for write operations.

---

## 14. Non-functional requirements and deployment

### 14.1 Security

- Passwords and PINs hashed with argon2id or bcrypt (cost 12); never logged or returned.
- Access token (JWT, 15 minutes) in memory; refresh token (30 days, rotated) in an httpOnly, Secure, SameSite cookie.
- Login rate limiting: 5 failed attempts per login per 15 minutes; PIN attempts limited per terminal.
- HTTPS only (TLS 1.2+), HSTS.
- Tenant isolation enforced in the repository layer and covered by automated tests for every role.
- Strict validation; protection against NoSQL injection.
- API keys, device tokens, webhook secrets and fiscal credentials stored hashed or encrypted.
- Audit log for logins, price changes, refunds, discounts above limit, removed lines, stock adjustments, fiscal setting changes, shop blocking, impersonation.
- Secrets only in environment variables.

### 14.2 Performance

| Metric | Target |
| --- | --- |
| Barcode lookup and add to cart | Under 200 ms (95th percentile), also offline |
| Sale save to print start (non-fiscal) | Under 1 s |
| Typical panel page load | Under 2 s |
| Dashboard and reports for 1 year of data | Under 5 s |
| Catalog size per shop | At least 50,000 products |
| Price matrix | 5,000 products × 20 branches editable without lag (virtualized table) |
| Concurrent terminals | At least 500 at launch, horizontally scalable |

### 14.3 Reliability

- MongoDB replica set (3 nodes) or managed cluster.
- Daily full backups plus continuous oplog backup; 30-day retention; monthly restore test.
- Availability target 99.5% per month; offline mode protects the cash desk during outages.
- Health check endpoint, monitoring and alerts (uptime, errors, response time, disk, database).
- Centralized logs, 30-day retention.

### 14.4 Compatibility

- Browsers: latest Chrome, Edge, Firefox; POS officially supported in Chrome and Edge on Windows.
- Screens: POS from 1024×768; panels responsive from 360 px wide.
- Agent: Windows 10 and 11, 64-bit.
- Reference hardware for acceptance: Netum A5 scanner, Xprinter XP-58IIL printer.

### 14.5 Code quality

- TypeScript everywhere; ESLint and Prettier.
- Monorepo (Turborepo or pnpm workspaces): `apps/web`, `apps/api`, `apps/agent`, `packages/shared` (schemas, types, translations keys, constants).
- Unit tests for stock, cost, price, promotion, loyalty and shift calculations; API integration tests; at least 70% coverage of business logic.
- End-to-end tests (Playwright): create shop, admin login, add product, set prices, receive stock, sell, offline sale and sync, return, close shift.
- Every interface text through translation keys; CI fails if a key is missing in any of the three languages.

### 14.6 Deployment

| Component | Deployment | Notes |
| --- | --- | --- |
| Next.js web app | Docker container | Domain configured by environment variable (not chosen yet) |
| Express API | Docker, 2+ instances behind Nginx | WebSocket with Redis adapter |
| MongoDB | 3-node replica set or managed MongoDB Atlas | Not exposed to the internet |
| Redis | Docker container | Rate limiting, WebSocket adapter, cache, job queue |
| Workers | Worker container (BullMQ) | Exports, nightly summaries, scheduled prices, shop expiry, webhooks, Telegram |
| File storage | S3-compatible storage | Images, exports, agent installers |
| Nginx | Reverse proxy | TLS (Let's Encrypt once the domain exists), gzip, WebSocket upgrade |
| Monitoring | Uptime monitor, Sentry, metrics | Alerts to the superadmin by Telegram |

- Git with protected main branch and code review.
- CI: lint, type check, tests, Docker build; CD to staging on merge, to production on tag.
- Versioned migration scripts for data and indexes.
- `.env.example` documents all configuration, including the domain.
- Agent builds code-signed (recommended) and published with version metadata.
- The superadmin account is created by a one-time seed command.

---

## 15. Development stages and acceptance

### 15.1 Stages

Each stage ends with a working result on the staging server.

1. Foundation: monorepo, CI, Docker, database, authentication, roles and permissions, tenant middleware, superadmin seed, audit log, three-language setup.
2. Superadmin panel: dashboard, create shop with admin, currency and fiscal toggle, shop list and details, block and unblock, payments, expiry, impersonation.
3. Shop structure and catalog: settings, branches, terminals, staff, categories, products, barcodes, import and export, per-branch price matrix, scheduled prices.
4. Stock and suppliers: suppliers, goods receipts, supplier returns and payments, branch stock, movements, transfers, write-offs, counts, negative stock handling.
5. POS and agent: local agent with Xprinter XP-58IIL and Netum A5, POS screen, shifts, sales, discounts, hold, returns, cash operations, X and Z reports.
6. Customers and offline: customers, loyalty, customer debts, promotions, offline mode with sync.
7. Reports and integrations: dashboard, all reports with export, Telegram bot, API keys, public API, webhooks, API documentation page.
8. Fiscal integration and launch: fiscal adapter and first provider, MXIK codes, fiscal receipts and refunds, load testing, security review, production launch.

### 15.2 Acceptance criteria

- The superadmin creates a shop with name, admin full name, phone, login and password (currency UZS by default, fiscal on or off); the admin logs in and sees only that shop.
- No user of shop A can read, change or detect data of shop B through the UI or API (automated tests).
- A blocked or expired shop cannot log in, use API keys or print through its agents; after unblocking all data is intact.
- The whole interface, receipts and Telegram messages are available in Uzbek, Russian and English.
- The shop admin switches currency between UZS, USD and RUB before the first sale; after the first sale the currency is locked. All times show Tashkent time.
- Only the shop admin can set prices; each branch sells at its own price; a product without a price in a branch cannot be sold there.
- A sale with insufficient stock succeeds with a warning when negative stock is allowed, and is refused when the shop admin has blocked it.
- Scanning with the Netum A5 adds a product in under 200 ms, also with a Russian keyboard layout active; the Xprinter XP-58IIL prints a correct 32-character receipt with Uzbek, Russian and English text.
- Sales made offline are printed, synced after reconnection without duplicates, and appear in reports.
- In a fiscal shop, every sale and refund carries fiscal data and products without MXIK code cannot be sold; in a non-fiscal shop no fiscal step occurs.
- Stock always equals the sum of its movements; shift closing shows the correct expected cash; report totals match the receipt journal.
- The API page shows only the shop's own keys, and the documented endpoints work with a created key.
