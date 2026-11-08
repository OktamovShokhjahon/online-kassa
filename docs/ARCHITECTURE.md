# Architecture

```
 Browser (Next.js)                         Cash desk PC
 /superadmin /shop /pos                    ┌────────────────────┐
   │  same-origin /api/v1 (rewrite)        │ Online Kass Agent  │── ESC/POS printer, drawer
   ▼                                       │ ws://127.0.0.1:17890│── serial scanner
 Nginx ──► API (Express) ◄──── ws (outgoing, heartbeat) ──┘     │
            │   │   └─ workers: shop expiry, scheduled prices, webhooks, Telegram
            │   └─ fiscal provider (mock | http-json)
            ▼
         MongoDB (replica set, transactions)
```

## Packages

* **`packages/shared`** is consumed as TypeScript source. It owns permissions, Zod schemas, the promotion
  engine (`applyPromotions`, used by the API *and* the POS so totals match), money/time/phone/barcode
  helpers and the three-language message tree. A parity test fails CI when a key is missing in any language;
  `apps/web/scripts/i18n-usage.ts` fails CI when the web source uses a key that does not exist.
* **`apps/api`** is layered `routes → services → models`. `TenantRepo` forces `shopId`; the `tenantGuard`
  plugin throws on unscoped queries and aggregates unless a call opts in with `crossTenant: true`
  (superadmin and workers only).
* **`apps/web`** keeps the access token in memory and renews it from the httpOnly refresh cookie. A
  `kass_role` cookie is only a routing hint for middleware; every API call is authorised again.
* **`apps/agent`** accepts WebSocket connections from allowed web origins only, authenticates the POS with an
  HMAC session key it can verify offline, and keeps a second outgoing link to the server for fallback printing
  and heartbeat.

## Authentication

Short-lived JWT access token (15 min) + rotating refresh token in an httpOnly cookie with reuse detection
(a replayed refresh token revokes the whole family). Passwords and PINs are bcrypt-hashed. Manager approval
for discounts and refunds is a login + PIN checked server-side with rate limiting. Superadmin impersonation
issues a 60-minute token that is audited.

## Sales, stock and fiscalization

1. POS sends lines `{productId, qty, price?}`; the server re-reads prices, applies promotions, checks
   discount limits (manager approval above the cashier limit) and payment arithmetic.
2. In fiscal shops the fiscal module is called **before** the sale is saved; a failed or slow (>10 s)
   fiscalization aborts the sale. Every fiscal exchange is stored in `FiscalLog` with secrets redacted.
3. The sale, the stock movements (`StockTx.move`, weighted-average cost), bonus accrual and shift counters
   are written in one transaction. `clientRequestId` makes every sale idempotent.
4. Refunds are proportional (bonus and debt are reversed in the same ratio) and idempotent too.

## Offline POS

The catalog (products, prices, promotions, customers) is cached in IndexedDB and refreshed incrementally.
When the server cannot be reached, a sale is queued with a local number and printed from a locally built
receipt. Offline is refused for bonus/credit payments, discounts that need approval, returns, and — in fiscal
shops — unless the provider supports deferred fiscalization. On reconnect the queue is sent through
`POST /sales/sync`: sales are applied in order, idempotently, keep the price the customer paid, and record
conflicts (changed price, negative stock). A shift cannot be closed while sales are still queued.

## Integrations

* **Public API** `/api/v1/public/*` with hashed API keys, scopes and a 120 req/min limit; OpenAPI at `/api/v1/docs` (Swagger UI in the shop panel under Developers).
* **Webhooks**: signed (HMAC-SHA256), retried with exponential backoff, SSRF-guarded destination check.
* **Telegram**: per-shop notification settings and platform alerts for the owner.
* **Domain event bus** (`lib/events.ts`) feeds webhooks, Telegram and the audit trail.

## Known limits

* Workers run inside the API process (no Redis/BullMQ). Run `RUN_WORKERS=true` on one instance only.
* The agent hub keeps live agent sockets in memory. With several API instances route `/api/v1/agent/ws`
  with sticky sessions, or add a Redis pub/sub relay.
* Label PDFs transliterate Cyrillic unless a TTF with Cyrillic glyphs is placed at
  `apps/api/assets/fonts/label.ttf`.
* Customer cash repayment requires an open shift of the recording user.
* An impersonation token is not renewable: after it expires the refresh restores the superadmin session.
