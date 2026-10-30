# 43 · Redelivered acquirer callbacks pile up duplicate fraud notes

**Severity:** Medium (FP-201) · **Area:** `apps/api/src/acquirer/callbacks.ts`, `db/migrations/0078_acquirer_callback_notes_unique.sql`

**What's wrong.** Acquirers resend callbacks when they don't get an answer
fast enough. Every resend added another copy of the same fraud verdict to
the payment's timeline.

**Why it's wrong.**
- HANDOVER says callbacks "are recorded in `processed_events` before
  they're applied, so redeliveries are dropped". No such table exists.
- `acquirer_callback_notes.callback_id` had no unique index; 0051's comment
  defers it to a later ticket.
- The route's own retry wrapper could also insert twice.
- The postmortem marks this action "Done".

**Spread / what it breaks.** Cluttered and misleading timelines (the same
verdict three times), and any count of fraud reviews is inflated.

**Fix.**
- New migration `0078` removes existing redundant copies, keeping the first
  received, and adds a **unique index** on `callback_id`.
- The insert is `ON CONFLICT DO NOTHING`, so a redelivery is still answered
  200 (the acquirer stops retrying) but recorded once.

**Tests.** New file `apps/api/src/routes/acquirerCallbackDedup.test.ts`,
using signed callbacks:
- The same callback twice gives 200 both times and 1 note.
- Three simultaneous deliveries give 1 note.

Before the fix: 2 and 3 notes. After it, both pass with all callback
tests. Full suite (fresh database): no new failures.
