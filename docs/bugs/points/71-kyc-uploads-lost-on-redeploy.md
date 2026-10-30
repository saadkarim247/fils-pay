# 71 · Every redeploy deletes merchants' KYC documents

**Severity:** High (compliance documents lost; onboarding records point at missing files) · **Area:** `ops/docker-compose.yml`, `apps/api/src/onboarding/kyc.ts`

**What's wrong.** Merchants upload ID and licence documents for KYC. The
API writes them to `KYC_UPLOAD_DIR`, which defaults to `./data/kyc` inside
the API container. The compose file gave that directory no volume, so the
files lived in the container's throwaway layer. Every
`docker compose up --build` (every deploy, every config change) recreates
the container and **deletes all uploaded documents**. The database rows
still point at them, so viewing a document afterwards fails.

**Why it's wrong.** KYC documents are records the business must keep. A
deployment must recreate containers freely without losing data, and the
brief's capacity test explicitly checks that the stack "restarts itself and
recovers without losing data".

**Spread / what it breaks.** Every merchant who ever uploaded a document,
on every environment built from this compose file: KYC review, compliance
audits and the admin console's document view.

**Fix.** A named volume `filspay_kyc` mounted at `/data/kyc`, with
`KYC_UPLOAD_DIR=/data/kyc` set explicitly. Postgres data already had a
volume; the uploads were the one piece of state that didn't.

**Evidence.** In the running stack, a file was written, then the API
container was force-recreated (a new container id each time):
- **Old path** `/app/data/kyc/doc.txt` → `FILE GONE`.
- **New path** `/data/kyc/…/doc.txt` → still there.
