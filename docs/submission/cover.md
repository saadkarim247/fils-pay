# FilsPay: The Handover

**Team:** Gameover

| Member | Owned |
|---|---|
| Saad Karim | Audit and fixes (findings 01–79), FP-300 refunds, AI setup and agent workflow |
| Maaz Karim | Hosting on Dilmune Cloud, load testing and profiling, live demo and UI evidence, submission documents |

### Live deployment (Dilmune Cloud)

| What | URL |
|---|---|
| Checkout (payment link) | https://165-232-180-63.sslip.io/pay/plink_H_dwVXDZOMOVGmmjsqBHVR |
| Merchant dashboard | https://165-232-180-63.sslip.io/dashboard/login |
| Admin console | https://admin.165-232-180-63.sslip.io |
| Public API | https://165-232-180-63.sslip.io/v1 |

Login details for the judges are on the next page. They exist only in this PDF, never in the repository (finding 76).

### Code

- **Public fork:** https://github.com/saadkarim247/fils-pay
- **Last commit before the deadline:** shown on the cover of the submitted PDF (this file is committed before that commit exists)
- **Per-finding notes:** `docs/bugs/points/` (one file per finding, one commit per fix)
- **This document's sources:** `docs/submission/` (rebuild with `node docs/submission/build.mjs`)
