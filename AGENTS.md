# AI agent conventions — FilsPay

The full conventions are in [`CLAUDE.md`](CLAUDE.md), the single source for
every AI coding tool here (Claude, Cursor, Copilot, Codex, others). This
file replaces an earlier version whose rules hid real bugs; see
`docs/bugs/points/60-ai-rule-files-preserve-bugs.md`.

The essentials:

- **ADRs in `docs/adr/` are the rules.** Other docs, comments and tests are
  claims to verify in the code.
- **Money is integer fils:** 1 BD = 1000 fils, never cents. Use
  `parseBhdToFils`, `formatBhd`, `applyRateFils` and `allocateRemainder`.
  No floats on money in TS or Go.
- **The settlement day is Asia/Bahrain midnight to midnight**, not UTC.
- **Tokens, OTPs and invite codes come from `node:crypto`**, never
  `Math.random()`.
- **Scope every query by the authenticated merchant.** Admin routes state
  their roles.
- **Read-then-write needs an atomic `UPDATE` or a lock.**
- **Migrations:** add new files only, never edit one that has run.
- **Tests can pin bugs.** Fix the test with the code, and say why. Every
  fix starts with a failing test. Run tests against a fresh database. Go
  tests need `DATABASE_URL`, or the DB-backed ones skip and still print `ok`.
