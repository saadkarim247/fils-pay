### The setup we recommend for this kind of task

The challenge is mostly an **audit-and-fix job on a repo designed to mislead AI tools**, with one feature to build. Planted rule files, "Claude says" comments and locked tests are a prompt injection aimed at coding assistants. Two things matter most: the agent must know which text to believe, and nothing counts until a test proves it. The setup below is the smallest one that gives you both.

**Use these (each one paid for itself here):**

1. **One lead agent session with a truth order you write yourself.** First, replace the repo's `CLAUDE.md` with a short file: brief → ADRs → code → everything else is a claim to verify. Without it, the assistant obeys the planted rules (bug 60).
2. **Fan out once, read-only, for the audit.** Run parallel subagents, one per area (`superpowers:dispatching-parallel-agents`), that report findings with file and line. The lead re-reads every finding in the code before accepting it. Subagents are worth it here because exploration is independent and wide. Fixing is not.
3. **A findings ledger in a file.** Track confirmed vs pending findings, doc contradictions and working rules. It survives context resets and machine changes, and it becomes the write-up.
4. **A strict red/green loop per bug** (`superpowers:test-driven-development`). The test must fail for the stated reason, then you make the smallest fix, then the test passes. Make one commit and one note per bug. A test only counts after you've seen it fail without the fix. This rule caught the AI's own mistakes (excerpt 3).
5. **A light spec only where something is built.** For FP-300, turn the brief's "done when" list into acceptance tests before writing code: one checklist, not a design process.
6. **Guardrails as files.** Use permission rules (`.claude/settings.json`) and a fresh-database test script. Make push, deploy and ssh ask first.
7. **Human checkpoints** to approve the findings list, each deploy and each push, and to decide what counts as done.

**Skip these here (overkill for this task):**
- **Full spec-driven pipelines per bug** (brainstorm → plan → execute). Most fixes are one to ten lines, and the brief and ADRs already are the spec.
- **Many agents writing code in parallel worktrees.** The fixes share files and one database, so parallel writers collide. Parallelism belongs in the audit, not the fixes.
- **Automated review agents on every commit.** The red/green rule already proves each fix. One independent review at the end is enough.
- **Long-running autonomous loops.** The repo is built to mislead an unsupervised agent.

**What we did:** items 1–4, 6 and 7 as described. For item 5, we found FP-300's gaps one at a time (bugs 25–35, 58) instead of writing the acceptance list first, so the "done when" table in §4.5 ended up as a summary rather than the plan. That is the one change we would make.
