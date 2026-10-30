# 47 · KYC "must be a PDF" checks the file name, and images can exhaust the server

**Severity:** Medium (KYC control bypass; denial of service) · **Area:** `apps/api/src/onboarding/kyc.ts`, `kycThumbnail.ts`

**What's wrong.** There are two problems in the KYC document upload.
1. **The PDF rule checks names, not bytes.** Commercial registrations and
   bank letters must be PDFs, but the rule looked at the **file name**. A
   phone photo renamed `CR-2026.pdf` was accepted, while a genuine PDF
   without a `.pdf` name was refused.
2. **There is no limit on decoded image size.** Thumbnails are made with
   `sharp` at its default limit of about 268 megapixels. A small, highly
   compressed image can declare an enormous canvas and decode to hundreds
   of MB.

**Why it's wrong.**
- ARCHITECTURE: "KYC uploads are validated by detected content type (magic
  bytes)". The code even had the detected type in hand and didn't use it.
  MK's comment that it was "fixed in FP-231" is false.
- The 8 MiB upload cap limits the file, not what it decodes to. FH flagged
  this.

**Spread / what it breaks.**
- Reviewers can be handed a photo in place of an official registry PDF.
- Any signed-up merchant can tie up the server's memory and CPU with a few
  uploads.

**Fix.**
- The PDF-only rule uses the detected type: `detected !== "pdf"` is
  refused, whatever the name.
- `sharp` is capped at 50 MP (`limitInputPixels`). That is well above any
  phone or scanner photo, and far below a bomb.

**Tests.** New file `apps/api/src/onboarding/kycUploadRules.test.ts`:
- a JPEG named `.pdf` is refused;
- a real PDF named `scan_0001` is accepted;
- an 81 MP image that is small on disk is refused;
- a normal photo still gets a thumbnail.

Before the fix 3 of 4 failed. After it, all pass.

**Existing test corrected.** `app.test.ts` sent real PDF bytes named
`.docx` and expected a refusal, which pins the name rule. It now sends JPEG
bytes named `.pdf`, the case the rule exists for, and still expects 422.
Full suite (fresh database): no new failures.
