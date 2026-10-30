---
description: Full test suite on fresh databases, compared to the known baseline
---

Run the whole suite:

```bash
tools/suite.sh
```

It rebuilds the migrate image, migrates two fresh databases (reporting gets
its own, see CLAUDE.md "Tests"), runs every TS workspace, `scripts/`, `db/`,
five typechecks, `go vet` and `go test -p 1`, and lists failures that are not
in `tools/suite-baseline.txt`. The baseline is empty: every failure is new.

Report:
- tests and failures per package, typechecks, go vet, Go packages ok/FAIL;
- every failure, and for each: caused by the current change, or pre-existing
  (read the test and the diff to decide; never stash or discard work to
  find out);
- whether it is safe to commit.

Never "fix" a failure by weakening a test or adding it to the baseline. If a
test pins a bug, correct it in the same change with a comment naming the bug
note.
