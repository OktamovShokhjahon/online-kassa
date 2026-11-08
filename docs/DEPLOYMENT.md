# Deployment

> The container files were written but **not built or run** in the development environment (no Docker
> available there). Treat the first `docker compose build` as part of the acceptance test.

## Requirements

* A Linux host with Docker 24+ and Compose v2 (or Node.js 20 + MongoDB 7 configured as a replica set).
* A domain name pointing at the host and TLS. Nothing in the code is tied to a domain: set `WEB_ORIGIN`
  and `PUBLIC_API_URL` to your public address.

## Docker Compose

```bash
cp .env.example .env
openssl rand -hex 32        # -> ENCRYPTION_KEY (exactly 64 hex characters)
openssl rand -hex 32        # -> JWT_ACCESS_SECRET
openssl rand -hex 32        # -> JWT_REFRESH_SECRET
$EDITOR .env                # also SUPERADMIN_LOGIN / SUPERADMIN_PASSWORD, WEB_ORIGIN, PUBLIC_API_URL

docker compose up -d --build
docker compose exec api node dist/scripts/migrate.js          # indexes and counters
docker compose exec api node dist/scripts/seed-superadmin.js  # first platform owner
```

The API refuses to start in production with the development default secrets.

MongoDB runs as a single-node replica set (required for transactions). For production use a managed
replica set (3 nodes) and put its URI into `MONGO_URI`; remove the `mongo` service from the compose file.

### TLS

Either terminate TLS at a load balancer in front of the `nginx` container, or add a `listen 443 ssl` server
block with your certificates to `docker/nginx.conf`. Keep `COOKIE_SECURE=true` (the default in production).
The refresh cookie is first-party: the browser talks to the web origin, which proxies `/api/v1` to the API.

### Scaling and background jobs

* Run **one** API instance with `RUN_WORKERS=true`; additional instances need `RUN_WORKERS=false`
  (or run `node dist/worker.js` as a separate service).
* The agent hub holds agent sockets in memory; with several API instances use sticky routing for
  `/api/v1/agent/ws` (Nginx `ip_hash`) or add a Redis relay.
* Uploads go to `UPLOAD_DIR` (a volume) or to S3-compatible storage when the `S3_*` variables are set.

## Backups

* `mongodump --uri "$MONGO_URI" --gzip --archive=backup-$(date +%F).gz` nightly, copy off-host.
* Back up the uploads volume. Back up `.env` separately: **losing `ENCRYPTION_KEY` makes stored fiscal
  credentials and agent tokens unreadable.**
* Restore drill: `mongorestore --gzip --archive=backup.gz --nsInclude 'onlinekass.*'` into a scratch instance
  and log in as a shop owner before relying on a backup.

## Upgrades

```bash
git pull
docker compose build api web
docker compose up -d
docker compose exec api node dist/scripts/migrate.js
```

Migrations are idempotent. Roll back by redeploying the previous image tag; the data model only adds fields.

## Health and monitoring

* `GET /api/v1/health` returns `{status, db, uptime}`; the API container healthcheck uses it.
* Logs are structured JSON on stdout with secrets redacted. `SENTRY_DSN` is reserved in the configuration, but error forwarding to Sentry is not wired up yet.
* Telegram alerts for the platform owner need `TELEGRAM_BOT_TOKEN` and `SUPERADMIN_TELEGRAM_CHAT_ID`.

## Without Docker

```bash
npm ci && npm run build
# API
NODE_ENV=production node apps/api/dist/server.js
# Web
cd apps/web && API_URL=http://127.0.0.1:4000 npm run build && npm run start
```

Run both under systemd or pm2 behind Nginx using `docker/nginx.conf` as the template.
