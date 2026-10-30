## 2. Architecture and deployment

![FilsPay deployment: services, ports and what faces the internet](img/architecture.svg)

FilsPay runs on one Dilmune Cloud VM (Ubuntu 24.04, 1 vCPU, 1.9 GiB RAM) as one Docker Compose project, `ops/docker-compose.yml`. The firewall (ufw) allows only 22, 80 and 443.

Only **sshd (22)** and the **Caddy proxy (80/443)** face the internet. Docker bypasses ufw for any port a container publishes, so only the proxy publishes one. The API binds to `127.0.0.1:3000`, and Postgres and settlement publish nothing.

| Service | Port | Exposure | CPU / memory cap | Restart | Health check |
|---|---|---|---|---|---|
| **proxy** (Caddy) | 80, 443 | **Internet**: TLS (Let's Encrypt); serves the web and admin apps; `/v1/*` → api | 0.4 / 96 MB | unless-stopped | starts once the api is healthy |
| **api** (Node, Fastify) | 3000 | internal + host loopback | 0.5 / 512 MB | unless-stopped | `GET /readyz` every 10 s |
| **settlement** (Go) | 8091 | internal; bearer token | 0.1 / 128 MB | unless-stopped, **60 s stop grace** | — |
| **reporting** worker | — | internal | 0.1 / 256 MB | unless-stopped | — |
| **postgres** 16 | 5432 | internal, not published | 0.5 / 640 MB | unless-stopped | `pg_isready` every 2 s |
| **backup** (pg_dump) | — | internal | 0.1 / 64 MB | unless-stopped | — |
| **migrate** (one-off) | — | internal | 0.5 / 384 MB | once per deploy | must exit 0 first |

The acquirer simulator, the webhook dispatcher and the checkout recovery pass run inside the API process. The CPU caps are ceilings on the shared vCPU, not reservations.

### Redeploy: one command

```bash
DEPLOY_HOST=165.232.180.63 DEPLOY_USER=dilmune ops/deploy.sh
```

It ships exactly the committed `HEAD` (`git archive`) and keeps the server's own `ops/.env`. Then it runs `docker compose -p filspay up -d --build`: the `migrate` job first, then the services in dependency order. Volumes survive: database, KYC uploads, certificates and backups. It refuses to run in the settlement window unless `FORCE=1`.

### Secrets

- `ops/init-env.sh` generates `ops/.env` once, **on the server**, from `openssl rand`: DB password, webhook key, internal token, callback secret and fixture passwords. The file is mode 600 and is never overwritten.
- It is never in git and never leaves the box. Every secret in compose is `${VAR:?}`, so a missing value stops the deploy.
- Fixed along the way: a committed secret (bug 72) and public seed passwords on the live admin (bug 76).

### Health checks and restarts

- **Restarts:** every service has `restart: unless-stopped`. In a crash test the API was back in ~7 s.
- **Health checks** set start order: the API waits for a healthy Postgres and a finished migration, and the proxy waits for a healthy API. Traffic never reaches an API that can't reach its database.

### A redeploy never interrupts a settlement run

Settlement closes yesterday at **00:15 Bahrain** (21:15 UTC) and takes ~4 s. Three layers protect it:
1. **`deploy.sh` refuses 23:55–00:30 Bahrain** unless `FORCE=1`. It works the window out from `date -u`, so the laptop's time zone doesn't matter.
2. **`stop_grace_period: 60s`** replaces Docker's default 10 s before a SIGKILL. On stop, an open batch transaction rolls back, so nothing is half-written.
3. **Re-running is safe.** Each close and payout is one transaction that locks the batch row. Batches already closed or paid are skipped. The daemon re-checks on boot, and it won't close a day that hasn't ended (bug 40).

**Backups:** a nightly `pg_dump` at 02:30 Bahrain, 7 days kept, on the same disk. Copying it off the box is an open risk.
