# Security review and load-test notes

## Controls implemented (and covered by tests unless noted)

| Area | Control |
| --- | --- |
| Tenant isolation | `shopId` forced by `TenantRepo`; the `tenantGuard` plugin throws on any query/aggregate/`insertMany` without a shop scope unless `crossTenant` is set explicitly. Cross-tenant read/write attempts are tested (`apps/api/test/tenant.test.ts`). |
| Authentication | bcrypt (cost 12) for passwords and PINs; 15-min JWT access token; rotating httpOnly refresh cookie with reuse detection; Mongo-backed rate limits on login, PIN login and manager approval; generic error for unknown login vs. wrong password. |
| Authorization | Permission codes checked on every route (`requirePermission`), branch scoping for branch-bound roles, selling prices editable by the shop owner only (no delegable permission). |
| Input | Zod validation on every body/query/param; `noSqlGuard` rejects `$`-prefixed and dotted keys; request body size limits; uploads limited by type and size. |
| Output | Secrets (fiscal credentials, agent tokens, API keys, webhook secrets) are encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`) or stored only as hashes; the logger and the fiscal log redact secret-like keys; API keys are shown once. |
| Webhooks | HMAC-SHA256 signature over `timestamp.body`; destination validated against private/loopback/link-local addresses (SSRF guard) at creation and at delivery. |
| Local agent | Loopback only; `Origin` allow-list; HMAC session key verified offline; device token + secret DPAPI-protected on Windows. Not covered by hardware tests. |
| Transport | Helmet headers, `COOKIE_SECURE` default on in production, same-origin proxy so the refresh cookie is first-party; the API refuses to start in production with development default secrets. |
| Auditability | Append-only audit log for security-relevant actions, impersonation, price changes, refunds, approvals, shift events; platform-level audit for superadmin actions. |
| Money correctness | Integer minor units, server-authoritative pricing, idempotent sales/refunds (`clientRequestId`), transactions around stock + sale + shift counters. |

## Known gaps / recommended before a public launch

* No CSRF token. The refresh endpoint relies on `SameSite=Lax` cookies plus a strict CORS origin; add a
  double-submit token or `Origin` check on `/auth/refresh` if the platform is ever served on sibling subdomains.
* Error reporting (`SENTRY_DSN`) is configured but not wired up.
* No automated dependency/CVE scanning in CI yet (`npm audit` / Dependabot recommended).
* Rate limits are stored in MongoDB: fine for one region, replace by Redis for very high request rates.
* Penetration test and an independent review of the fiscal provider integration (real provider not chosen yet;
  only the mock and a generic JSON-over-HTTP adapter exist).
* The Docker/Nginx/CI files have not been executed in the development environment (no Docker there).

## Load test

`npm run loadtest -w @kass/api -- --url http://localhost:4000 --sales 300 --concurrency 10`
(`apps/api/src/scripts/loadtest.ts`) logs in as the demo cashier, opens a shift, posts sales of one product
with unique `clientRequestId`s, closes the shift and prints throughput and latency percentiles.

Measured once on a developer laptop, API in `tsx` dev mode against the **in-memory** MongoDB replica set
(`dev:stack`), all 300 sales for the **same single product** (worst case: every sale updates the same stock
document):

| Sales | Concurrency | Failed | Throughput | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 300 | 10 | 0 | 38.8 sales/s | 206 ms | 716 ms | 1081 ms |

This is a smoke-level number, not a capacity claim: a real shop produces roughly one sale per terminal per
several seconds, and sales of different products do not contend on one document. Repeat the test against the
production topology (replica set, built API, realistic catalog) before sizing hardware, and add a mixed
scenario (catalog sync, reports) if report-heavy usage is expected during trading hours.
