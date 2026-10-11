# Product Requirements Document
## Assessment 3 — AI Integration Slice ("Product Photos to Structured Listings")

---

### 1. Overview

This document specifies an AI-powered flow, built as a standalone slice inside an
existing Next.js application that already has a working authentication system. A
signed-in user uploads a product photo. A background job sends it to Gemini,
which extracts a structured listing description. The result is shown once
processing completes. From that result, the user can trigger one follow-up
action — "Expand" — which asks the same model, under a second, distinct system
prompt, to turn the structured data into a longer, full listing-style
description.

This is a slice, not a full application. It contains exactly one working flow —
upload, process, view, expand — built correctly, with nothing else around it.

---

### 2. Goals

- A user can upload a product photo (or several) and have it processed in the
  background, not blocking the request.
- Processing happens through two distinct roles served by one model: extraction
  (photo → structured JSON) and expansion (structured JSON → detailed listing
  description), each with its own system prompt.
- Output from the extraction role is structured data, validated against a schema
  in application code — never free text the code has to parse with string
  operations.
- Every unit of work has a job record with status, attempt count, and an error
  message on failure. A failure is told to the user honestly, not hidden behind
  a generic success state.
- Uploading many files at once never fires many simultaneous provider calls — a
  concurrency cap holds, demonstrably.
- The uploaded file itself never touches the database — only a storage key does.

---

### 3. Non-Goals (explicit)

Deliberately out of scope. Do not build these, even if they feel like natural
extensions:

- No landing page.
- No account system beyond what's needed to have a signed-in user — reusing
  Assessment 1's auth directly.
- No editing, sharing, re-ordering, or exporting of results.
- No listing history dashboard, search, or filtering beyond what's needed to
  view a single result.
- No external queue infrastructure (Redis, SQS, BullMQ) — concurrency control is
  handled in-process, in-memory.
- No multi-provider routing — one model (Gemini), two system prompts.

---

### 4. Users and Context

- The user is already authenticated via the existing auth system (reused, not
  rebuilt).
- A signed-in user reaches an upload screen directly — no separate landing step.
- One user can have many jobs (many separate photo uploads), each independent of
  the others.

---

### 5. Screens

**5.1 Upload view**
- Accepts one or more image files (product photos).
- Enforces file type (e.g. `image/jpeg`, `image/png`) and a maximum file size,
  both checked client-side for feedback and server-side as the actual
  enforcement.
- On submit, each file becomes its own `Job` row and is handed to the in-memory
  processing queue — the upload request returns immediately once jobs are
  created, it does not wait for processing to finish.

**5.2 Processing state**
- Shows each job's real status: `pending`, `processing`, `done`, or `failed`.
- Polls job status rather than guessing from the HTTP response of the upload
  call.
- A `failed` job shows a genuine, specific failure state — not a spinner that
  never resolves, not a silent disappearance.

**5.3 Result view**
- Shows the validated, structured extraction result for a completed job: title,
  short description, category, estimated tags.
- Includes the "Expand" action — the one required follow-up — which calls the
  expansion role and displays the resulting longer description underneath or
  alongside the structured data.

**5.4 Minimal signed-in shell**
- Reuses the existing dashboard/header from Assessment 1. No new navigation
  structure beyond a link to the upload view.

---

### 6. Core Behaviors

| Action | Behavior |
|---|---|
| Upload one or more files | Each file is validated (type, size), uploaded to Cloudflare R2, and a `Job` row is created with `status: "pending"`, storing only the R2 object key. The HTTP response returns immediately with the created job IDs — it does not wait for AI processing. Each job is simultaneously handed to the in-memory queue. |
| Background processing | An in-memory, concurrency-limited queue (e.g. `p-limit`, capped at `MAX_CONCURRENT_JOBS`) holds each job until a slot opens. When a job starts, it moves to `processing`, calls Gemini with the extraction system prompt, validates the response against a schema, and moves to `done` (with `result` populated) or `failed` (with `errorMessage` populated and `attempts` incremented). |
| Retry on transient failure | A job that fails due to a timeout or a transient provider error is retried up to a defined limit before being marked `failed` permanently. A job that fails schema validation after the defined retry attempts is marked `failed` with a specific validation error message, not retried indefinitely. |
| Server restart recovery | On boot, a startup hook (reusing the pattern already established in Assessment 1's `instrumentation.ts` for expired-token cleanup) resets any job still marked `processing` back to `pending`, so an in-memory job lost to a restart is picked up again rather than stuck forever. |
| View result | Once `status: "done"`, the result view renders `result` directly — no re-parsing of free text. |
| Expand (follow-up action) | A synchronous, rate-limited endpoint takes the job's structured `result`, sends it to Gemini under the expansion system prompt, with its own timeout, and returns the longer description. Stored on the job as `expandedResult`. Independent of the processing queue — a single on-demand call, not a new background job. |

---

### 7. Data Model (Prisma)

```prisma
model Job {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  status          String    // "pending" | "processing" | "done" | "failed"
  attempts        Int       @default(0)
  errorMessage    String?

  storageKey      String    // R2 object key — never the file itself
  originalFileName String
  fileSize        Int
  mimeType        String

  rawModelOutput  Json?     // Gemini's raw response, retained for evidence/debugging
  result          Json?     // validated, schema-conformant structured extraction
  expandedResult  String?   // longer listing description from the follow-up "Expand" action

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([userId])
  @@index([status])
}

model RateLimitAttempt {
  id           String   @id @default(cuid())
  identifier   String
  route        String   // e.g. "upload", "expand"
  attemptCount Int      @default(1)
  lockedUntil  DateTime?
  windowStart  DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([identifier, route])
}
```

**Design decisions baked into this schema:**
- `storageKey` is the only reference to the uploaded file anywhere in the
  database — satisfies "only the storage key in the database, never the file
  itself."
- `rawModelOutput` is kept separately from `result` specifically so there's a
  direct evidence pair: what Gemini actually returned, versus what your code
  validated and accepted.
- `attempts` and `errorMessage` live directly on `Job` rather than a separate
  attempts table, since each job's retry history doesn't need its own queryable
  row.
- `expandedResult` lives on the same row as the original job rather than a
  separate table, since it's a 1:1 follow-up on a specific job, not an
  independent unit of work.
- `status: "processing"` rows are treated as recoverable, not final — the
  startup sweep depends on this field being the single source of truth for "was
  this actually finished."

---

### 8. API Surface (expected endpoints)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/jobs/upload` | POST | Accepts file(s), validates type/size, uploads to R2, creates `Job` row(s) with `status: "pending"`, hands each to the in-memory queue. Returns immediately with job IDs. Rate limited. |
| `/api/jobs/:id/status` | GET | Returns the current status/result of a job, for the processing view to poll. |
| `/api/jobs/:id/expand` | POST | Triggers the expansion role on an already-`done` job's `result`. Rate limited, independently timed out. |

Background processing itself is not an HTTP endpoint — it's the in-memory
concurrency-limited queue, fed directly at upload time rather than discovered by
polling the database.

---

### 9. AI / Model Architecture

**Provider:** Gemini, via the official `@google/genai` SDK. One model, two
distinct system prompts.

**Role 1 — Extraction** (runs in the background job, on upload)
- Input: the uploaded product photo.
- Output: structured JSON matching a defined schema — `title`,
  `shortDescription`, `category`, `estimatedTags` (array).
- Requested via Gemini's structured output mode (`responseSchema` +
  `responseMimeType: "application/json"` on `generateContent`), not prose the
  code parses afterward.
- Validated again in application code on receipt — schema validation is not
  trusted from the provider alone — with a defined retry on failure and a
  defined graceful failure after retries are exhausted.

**Role 2 — Expansion** (runs on the follow-up "Expand" call)
- Input: the validated structured result from Role 1.
- Output: a longer, human-readable listing description — free text, not
  structured data, since this role's job is to produce readable prose for a
  human.
- Served by a distinct system prompt from Role 1, same underlying Gemini model.

**Config file** (holds every changeable value, not hardcoded in handlers):
- Gemini model identifier
- Per-role timeout (ms)
- Per-role output token cap
- Per-role temperature, each justified in one line (e.g. extraction near 0 for
  consistency, expansion slightly higher for natural prose)
- `MAX_CONCURRENT_JOBS`
- Rate limit thresholds for upload and expand endpoints

---

### 10. Security & Reliability Requirements

1. **Official SDK only** — `@google/genai`, not raw HTTP calls.
2. **API key written into `.env` by hand** — never generated or written by the
   agent. `.env.example` carries a commented placeholder only.
3. **Config file holds every changeable value** — model ID, timeouts, token
   caps, temperature, rate limits, concurrency — nothing hardcoded in a route
   handler.
4. **Written system prompt per role**, each parameter justified in a one-line
   comment.
5. **Structured output requested with a schema, validated in application code on
   receipt**, with a defined retry (e.g. one retry with a stricter prompt) and a
   defined graceful failure (job marked `failed` with a specific message) if
   validation still fails.
6. **A `Job` record for every unit of work** — status, attempts, error message
   on failure.
7. **Concurrency cap, enforced in-memory** — `MAX_CONCURRENT_JOBS` held by the
   queue, demonstrated (not just asserted) by uploading enough files at once and
   logging that only N provider calls are ever in flight.
8. **Rate limiting** on both the upload-triggering endpoint and the expand
   (follow-up) endpoint.
9. **Files in Cloudflare R2, only the key in the database.**
10. **A timeout on every model call**, with a defined fallback (job marked
    `failed` with a timeout-specific message, not left hanging).
11. **Restart recovery** — a startup hook resets orphaned `processing` jobs back
    to `pending`, so the in-memory queue's one real weakness (state lost on
    restart) doesn't silently strand jobs.

---

### 11. Environment & Configuration

Add to `.env.example` with commented placeholders (never commit real values):
```
GEMINI_API_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
```
Config values (model ID, timeouts, token caps, temperature, concurrency, rate
limits) live in a dedicated config file, not in `.env` and not hardcoded in
handlers.

---

### 12. Acceptance Criteria / Evidence to Capture

- Jobs table showing one successful run and one failed run, with the failure's
  error message visible.
- The raw model output for one request, alongside the validated, parsed result,
  shown side by side.
- Evidence of a deliberately broken schema/response and what the validation
  failure path actually does.
- The concurrency cap holding under load — upload enough files at once to show
  the provider request pattern respects `MAX_CONCURRENT_JOBS` rather than firing
  all at once.
- A database screenshot showing a `Job` row holds only `storageKey`, never the
  file itself.
- A restart mid-processing, showing an orphaned `processing` job reset to
  `pending` and successfully reprocessed.

---

### 13. Open Questions (resolve before or during build, do not guess silently)

- Exact file size limit and accepted MIME types for uploads.
- Retry count and backoff for a transient provider failure before a job is
  marked permanently `failed`.
- Polling interval for the processing view.
- Exact temperature and token cap per role — pick values and justify them in
  Section 5 of `DOCUMENTATION.md`, since this is an explicit defense question in
  the brief.
