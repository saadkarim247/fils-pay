# ops/

FilsPay's stack: Postgres, apps/api, apps/settlement (Go daemon) and
apps/reporting (outbox worker), plus one-off `migrate` and `seed` jobs.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | The stack, production-shaped. **The server runs this file alone.** |
| `docker-compose.override.yml` | Laptop-only additions (dev mode, local ports). Loaded automatically by `docker compose up` inside `ops/`. |
| `init-env.sh` | Writes `ops/.env` with fresh random secrets, once. |
| `.env.example` | The variables `ops/.env` must define. |
| `Dockerfile.node` | Image for api, reporting, migrate and seed (Node 22, runs TypeScript with tsx). |
| `Dockerfile.go` | Multi-stage build of apps/settlement into a distroless image. |

Secrets live only in `ops/.env`, which is in `.gitignore` and `.dockerignore`.
Compose refuses to start if one is missing. (The old `ops/.env.docker` was
committed with the callback signing secret and never loaded by compose; it
is gone and that secret must be treated as leaked.)

## Server (production)

```bash
ops/init-env.sh                                       # once; back up ops/.env
docker compose -f ops/docker-compose.yml up -d --build
docker compose -f ops/docker-compose.yml --profile seed run --rm seed   # optional demo data
```

## Laptop

```bash
POSTGRES_PASSWORD=filspay_dev_password ops/init-env.sh   # once (keeps an existing local volume's password)
cd ops && docker compose up -d                           # base + override: dev mode
docker compose --profile seed run --rm seed              # demo data
```

The dashboards run with Vite (`npm run dev -w apps/web`, `-w apps/admin`) and
proxy `/v1` to the API on `localhost:3000`.

## What the base file guarantees

| Property | How |
|---|---|
| Fits the box: 1 vCPU / 2 GB, API ≤ 0.5 vCPU / 512 MB | CPU limits: api 0.5, postgres 0.3, settlement 0.1, reporting 0.1 (sum 1.0). Memory: 512 / 640 / 128 / 256 MB. Node heaps capped below their container limits. |
| Restarts itself | `restart: unless-stopped` on every long-running service. Measured: a hard-killed API process is back and healthy in ~7 s. |
| Health | API healthcheck on `/readyz`; Postgres on `pg_isready`. Services start only after Postgres is healthy and migrations succeeded. |
| Not exposed | Postgres is not published. The API binds to `127.0.0.1` until the TLS proxy fronts it. Settlement's internal API (:8091) is reachable only on the compose network. |
| No data loss on recreate | Named volumes for Postgres data **and KYC uploads** (`/data/kyc`; these used to live inside the API container and vanished on every rebuild). |
| Production mode | `NODE_ENV=production`: the API refuses to start without it (bug 68), cookies are `Secure`, webhook URLs must be public https. |
| Disk | Container logs rotate at 10 MB × 3. |

## Database

Every service connects as the `filspay` role over the compose network
(`sslmode=disable` is acceptable there: the traffic never leaves the host).
Per-service roles are still a TODO.
