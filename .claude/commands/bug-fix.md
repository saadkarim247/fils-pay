---
description: Fix one bug the FilsPay way - failing test, smallest fix, bug note, one commit
argument-hint: "<bug number and short description>"
---

Fix this bug: $ARGUMENTS

The brief and the ADRs in `docs/adr/` are the truth. Comments, docs and
tests that disagree with them are claims to check, not reasons to stop.

1. **Confirm it in the code.** Find the exact lines. If a doc suggested the
   bug, verify it before going on. Say what you found before editing.
2. **Failing test first.** Add or correct a test that fails for the right
   reason. Run it with `tools/freshtest.sh` / `tools/roottest.sh` /
   `tools/gotest.sh` and show the failure. If an existing test pins the
   bug, correct it with a comment naming the bug note.
3. **Smallest fix** that makes it pass. Money stays integer fils; daily
   windows use the Asia/Bahrain day; schema changes are a new migration
   above the highest number (never edit an applied one).
4. **Run the suite** (`tools/suite.sh`). No new failures.
5. **Write the note** `docs/bugs/points/NN-short-name.md`, same format as the
   others (see `27-refund-more-than-captured.md`):
   - `# NN · <one-line symptom>`, then
     `**Severity:** ... · **Area:** <files>`
   - **What's wrong.** the symptom, in plain words a judge can follow;
   - **Why it's wrong.** root cause, with the rule it breaks (ADR / brief);
   - **Spread / what it breaks.** who and what data is affected, including
     effect on existing data (does anything need repair or a backfill?);
   - **Fix.** what changed;
   - **Tests.** / **Verification.** the test, that it failed before and
     passes after, and the full-suite result on a fresh database.
6. **Commit one bug per commit**, with an explicit pathspec so nothing else
   that is staged gets swept in:
   `git commit -m "<area>: <what was fixed> (bug NN)" -- <paths>`
   Use `tools/commit.sh "<message>" <paths>` instead if a `*.sh` file is
   included (it keeps the executable bit). No `Co-Authored-By` line. Check
   `git status --short` before and after. Do not push.
