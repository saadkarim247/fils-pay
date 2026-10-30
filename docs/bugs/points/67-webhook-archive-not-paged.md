# 67 · Webhook archives load the whole history into memory

**Severity:** Low (support-only tool, but it can take the API down) · **Area:** `apps/api/src/webhooks/archiveReplay.ts`

**What's wrong.** Support archives an endpoint's delivery history before a
merchant changes their webhook URL, then restores it onto the new URL.
- **Capture** read every delivery in the date range into the API's
  memory and wrote one JSON value.
- **Restore** parsed that whole value back.

A long range on a busy endpoint means hundreds of thousands of payloads in
memory at once, on the 512 MB API container.

**Why it's wrong.** ADMIN.md, the operator contract, says: "Archives are
written in pages of 1000 deliveries, so any range is fine." There was no
paging anywhere.

**Spread / what it breaks.** A support operator following the documented
"any range is fine" can exhaust the API process. That stops payments and
dashboards for every merchant while it restarts.

**Fix.**
- **Migration 0083** adds `webhook_delivery_archive_pages`.
- **Capture** writes 1000 deliveries per page in capture order, using a
  keyset over (created_at, id). The cursor stays a Postgres timestamp so
  microsecond ties aren't skipped.
- **Restore** reads one page at a time, still in one transaction, so a
  restore is all or nothing.
- **Nothing is capped**, so archives stay complete.
- **Old archives still work:** those taken before 0083 have no pages and
  restore from `archive_payload` as before.

**Tests.** New file `apps/api/src/webhooks/archivePages.test.ts`:
- 2,500 deliveries become pages of 1000, 1000 and 500, in order, and
  restore all 2,500.
- A pre-0083 archive still restores.

Before the fix the page table didn't exist. The existing
`archiveReplay.test.ts` read entries from `archive_payload`; it now reads
the pages, with a comment. All archive, endpoint and admin-merchant tests
pass.
