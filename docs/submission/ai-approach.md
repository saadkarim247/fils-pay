### How we ran the AI

The challenge was mostly an **audit-and-fix job on a repo designed to mislead AI tools**, with one feature to build. The planted rule files, "Claude says" comments and locked tests were a prompt injection aimed at coding assistants. Two things mattered most: the agent had to know which text to believe, and nothing counted until a test proved it. This is the setup we used.

**What we did:**

1. **One lead agent session, with a truth order we wrote ourselves.** We told the agent, before it read any code, that the brief and ADRs were the rules, then the code, and that everything else was a claim to verify. We then replaced the repo's `CLAUDE.md` with a short file stating that order. Without it, the assistant would have obeyed the planted rules (bug 60).
2. **We fanned out once, read-only, for the audit.** Seven parallel subagents, one per area (`superpowers:dispatching-parallel-agents`), each reported findings with file and line. The lead session re-read every finding in the code before accepting it. We used parallelism only for exploration. All fixes went through one session, one at a time.
3. **We kept a findings ledger in a file:** confirmed vs pending findings, doc contradictions and working rules. It carried us through context resets and a move between machines, and it became this write-up.
4. **We ran a strict red/green loop for every bug** (`superpowers:test-driven-development`). The test had to fail for the stated reason, then we made the smallest fix, then it passed. One commit and one note per bug. A test only counted once we had seen it fail without the fix. This rule caught the AI's own mistakes (excerpt 3).
5. **The brief's "done when" list was the spec for FP-300.** We checked refunds against each criterion: API, ledger to the fil, fees and payouts, webhook, timeline/reports/reconciliation, live. We fixed each gap with its own failing test first (bugs 25–35, 58).
6. **We put guardrails in files:** permission rules (`.claude/settings.json`), a fresh-database test script, and slash commands for the routine steps. Push, deploy and ssh always asked first.
7. **We kept human checkpoints.** We approved the findings list before any fix, approved every deploy and push, and decided what counted as done.

**What we deliberately didn't use, because it would have been overkill here:**
- **A full spec-driven pipeline per bug** (brainstorm → plan → execute). Most fixes were one to ten lines, and the brief and ADRs already were the spec.
- **Many agents writing code in parallel worktrees.** The fixes shared files and one database, so parallel writers would have collided.
- **Automated review agents on every commit.** The red/green rule already proved each fix.
- **Long-running autonomous loops.** The repo was built to mislead an unsupervised agent.
