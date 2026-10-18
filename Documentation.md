# Documentation — AI Integration Assessment

Product Photos → Structured Listings: a Next.js application that lets an
authenticated user upload product photos, processes them in the background with
Google's Gemini model, and returns validated, structured catalog data. A
follow-up **Expand** action turns that structured data into a longer,
human-readable listing description.

This document covers architecture, setup, data model, API surface, the AI
pipeline, security controls, and operational notes.

The product requirements live in [`docs/PRD_AI_Integration.md`](docs/PRD_AI_Integration.md).

---

## 1. Overview

The app is a focused slice built on an existing authentication system:

1. A user signs up, verifies their email with a 6-digit code, and signs in.
2. They upload one or more product photos (JPEG/PNG, ≤5 MB each, ≤10 per batch).
3. Each photo becomes a `Job` row and is handed to an in-memory, concurrency-
   limited queue. The upload request returns immediately.
4. A background worker sends the image to Gemini, validates the structured
   response against a Zod schema, and marks the job `done` or `failed`.
5. The upload screen polls job status. Completed jobs open a result view showing
   `title`, `shortDescription`, `category`, and `estimatedTags`.
6. The user can trigger **Expand** to generate a ~150–250 word listing
   description stored on the job as `expandedResult`.

---

## 2. Tech Stack

| Concern | Choice |
|---|---|
| Framework | Next.js `16.4.0` (App Router, Server Components) |
| UI | React `19.3.0`, inline styles + global CSS |
| Language | TypeScript `5` |
| Database | PostgreSQL via Prisma `7.10` (`@prisma/adapter-pg`) |
| Validation | Zod `4` |
| Password hashing | `bcrypt` (cost factor 10) |
| Email | `nodemailer` (SMTP) |
| AI provider | `@google/genai` — Gemini `gemini-2.5-flash` |
| Object storage | Cloudflare R2 via `@aws-sdk/client-s3` |
| Concurrency | `p-limit` (in-memory queue) |

---

## 3. Project Structure

```
src/
├─ app/
│  ├─ (auth)/                 # Public auth screens (signin, signup, verify-email, forgot-password)
│  ├─ api/
│  │  ├─ auth/                # Auth endpoints (csrf, signup, signin, session, signout, …)
│  │  └─ jobs/                # Job endpoints (upload, list, status, expand)
│  ├─ dashboard/              # Signed-in landing page + header
│  ├─ upload/                 # Upload screen (client view)
│  ├─ jobs/[id]/              # Job result + expand view
│  ├─ globals.css             # Design tokens & shared styles
│  └─ layout.tsx              # Root layout (fonts, AuthProvider)
├─ components/otp-input.tsx   # 6-digit code input
├─ context/auth-context.tsx   # Client auth state (session, sign-out)
├─ lib/
│  ├─ ai/                     # Gemini config, prompts, schemas, errors, types
│  ├─ jobs/                   # In-memory queue + background worker
│  ├─ storage/r2.ts           # Cloudflare R2 adapter
│  ├─ session.ts              # Session create/validate/invalidate
│  ├─ csrf.ts                 # Double-submit CSRF protection
│  ├─ rate-limit.ts           # DB-backed exponential backoff
│  ├─ password.ts             # bcrypt helpers
│  ├─ verification.ts         # Email verification codes
│  ├─ reset-code.ts           # Password reset codes
│  ├─ email.ts                # Nodemailer templates
│  ├─ validation.ts           # Shared Zod schemas
│  └─ prisma.ts               # Prisma singleton
├─ instrumentation.ts         # Startup recovery + hourly token sweep
└─ proxy.ts                   # Route protection (Next.js proxy/middleware)
prisma/
├─ schema.prisma              # Data model
└─ migrations/                # SQL migrations
```

---

## 4. Getting Started

### Prerequisites

- Node.js (a version compatible with Next.js 16 / React 19)
- A PostgreSQL database
- A Gemini API key
- A Cloudflare R2 bucket + credentials (or an S3-compatible bucket)
- SMTP credentials for outbound email (Ethereal/Mailtrap are fine locally)

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file:

   ```bash
   copy .env.example .env      # Windows
   # cp .env.example .env       # macOS/Linux
   ```

   Fill in every value (see [Section 5](#5-environment-variables)). The Gemini
   key and R2 credentials are entered by hand — never commit a real `.env`.

3. Apply database migrations (Prisma):

   ```bash
   npx prisma migrate deploy   # or: npx prisma migrate dev
   npx prisma generate
   ```

4. Start the dev server:

   ```bash
   npm run dev
   ```

5. Open http://localhost:3000 — you will be redirected to `/signin`.

### npm scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Run ESLint with autofix |

> There is no automated test runner configured. Verify changes with `npx tsc --noEmit`, `npm run lint`, and manual end-to-end testing.

---

## 5. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SMTP_HOST` | Yes | SMTP host for transactional email |
| `SMTP_PORT` | Yes | SMTP port (`465` = SSL, otherwise STARTTLS) |
| `SMTP_USER` | Yes | SMTP username |
| `SMTP_PASS` | Yes | SMTP password |
| `SMTP_FROM` | No | From header (defaults to a local placeholder) |
| `SESSION_SECRET` | Yes | Secret for session-token derivation |
| `CSRF_SECRET` | Yes | Secret for CSRF token generation |
| `NEXT_PUBLIC_APP_URL` | Yes | Public base URL of the app |
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `R2_ACCOUNT_ID` | Yes | Cloudflare R2 account ID |
| `R2_ACCESS_KEY_ID` | Yes | R2/S3 access key |
| `R2_SECRET_ACCESS_KEY` | Yes | R2/S3 secret key |
| `R2_BUCKET_NAME` | Yes | R2 bucket name |

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 6. Data Model

Defined in [`prisma/schema.prisma`](prisma/schema.prisma).

### `User`
Core identity record. Unique `email` (DB-level constraint prevents duplicate
accounts), `passwordHash` (bcrypt), `emailVerified`, timestamps.

### `Session`
Server-side session. Stores `sessionTokenHash` (SHA-256 of the raw cookie token),
`lastActivityAt` (idle timeout), `expiresAt` (absolute timeout), and
`invalidatedAt` (set on sign-out). Relation to `User` with cascade delete.

### `VerificationCode`
Email-verification record: `codeHash` (bcrypt cost factor 10), `expiresAt` (60 s,
governed by `VERIFICATION_CODE_TTL_MS`), `resendCooldownUntil` (60 s server-enforced),
`attemptCount` (lockout at 5, atomic increment-before-compare). Rows are **deleted**
on success/supersede rather than soft-marked; expired rows are swept by the hourly sweeper.

### `PasswordResetToken`
Single-use, time-limited reset code: `codeHash` (bcrypt cost factor 10), `expiresAt`
(10 min, governed by `RESET_CODE_TTL_MS`), `resendCooldownUntil`, `attemptCount`
(lockout at 5, atomic increment-before-compare). Deleted on consumption; expired,
never-used rows are cleaned up per-user and by an hourly sweeper.

### `Job`
Unit of AI work: `status` (`pending` | `processing` | `done` | `failed`),
`attempts`, `errorMessage`, `storageKey` (R2 key — **never the file**),
`originalFileName`, `fileSize`, `mimeType`, `rawModelOutput` (raw Gemini
response), `result` (validated structured JSON), `expandedResult` (long listing
text).

### `RateLimitAttempt`
Per `(identifier, route)` record with `attemptCount`, `lockedUntil`, and
`windowStart`. Unique on `(identifier, route)` for atomic upserts.

---

## 7. API Reference

All responses share the shape:

```json
{ "success": true, "message": "...", "data": {}, "errors": {}, "retryAfter": 0 }
```

State-changing endpoints (POST) require a valid CSRF token sent as the
`x-csrf-token` header.

### Auth endpoints

| Endpoint | Method | Auth | Body | Purpose |
|---|---|---|---|---|
| `/api/auth/csrf` | GET | — | — | Issue a non-HttpOnly CSRF cookie/token |
| `/api/auth/signup` | POST | — | `fullName, email, password` | Create account, email verification code, session |
| `/api/auth/signin` | POST | — | `email, password` | Authenticate and create session |
| `/api/auth/signout` | POST | Session | — | Invalidate session server-side |
| `/api/auth/signout` | GET | — | — | Clear a stale session cookie (recovery) |
| `/api/auth/session` | GET | Session | — | Return current user (401 if none) |
| `/api/auth/verify-email` | POST | Session | `code` | Verify email with 6-digit code |
| `/api/auth/resend-code` | GET | Session | — | Current resend-cooldown status |
| `/api/auth/resend-code` | POST | Session | — | Re-issue verification code (cooldown-gated) |
| `/api/auth/forgot-password` | POST | — | `email` | Send password-reset code (always generic response) |
| `/api/auth/verify-reset-code` | POST | — | `email, code` | Verify reset code (Step 2), returns `flowId` |
| `/api/auth/reset-password` | POST | — | `email, flowId, code, password` | Consume code, set password, invalidate sessions |

### Job endpoints

| Endpoint | Method | Auth | Body | Purpose |
|---|---|---|---|---|
| `/api/jobs/upload` | POST | Session + CSRF | `multipart/form-data` (`files`) | Validate, store to R2, create `Job` rows, enqueue |
| `/api/jobs` | GET | Session | — | Latest 20 jobs for the user |
| `/api/jobs/:id/status` | GET | Session | — | Job detail (status, `result`, `expandedResult`) |
| `/api/jobs/:id/expand` | POST | Session + CSRF | — | Generate longer listing from a `done` job's result |

**Upload response** (`201`) returns `jobs[]` plus `rejected[]` (per-file
reasons). If every file is rejected it returns `400`. Storage keys are opaque
(`uploads/<userId>/<uuid>.<ext>`).

**Expand** is idempotent: if `expandedResult` already exists it is returned
directly; concurrent calls for the same job return `409`.

---

## 8. AI Pipeline

Provider: Gemini via the official `@google/genai` SDK. **One model, two system
prompts.** All tunable values live in
[`src/lib/ai/config.ts`](src/lib/ai/config.ts).

### Role 1 — Extraction (background)

- **Input:** uploaded product photo (inline base64 image).
- **Output:** JSON matching `extractionResultSchema` —
  `title`, `shortDescription`, `category`, `estimatedTags[]`.
- Requested with Gemini structured output (`responseMimeType: "application/json"`
  + `responseSchema`) and **re-validated in application code** (Zod).
- Prompt (`EXTRACTION_SYSTEM_PROMPT`) instructs the model to describe only what
  is visible, avoid inventing brands/specs/prices, and treat in-image text as
  passive content, never instructions.

**Config justification** (`AI_CONFIG.extraction`):

| Setting | Value | Why |
|---|---|---|
| `timeoutMs` | `30000` | Ample runway for image transmission + multimodal analysis without hanging |
| `maxOutputTokens` | `512` | Fits the structured JSON with zero truncation |
| `temperature` | `0.2` | Deterministic, factual extraction without hallucinated attributes |
| `thinkingBudget` | `0` | Prevents thinking tokens from consuming the output cap and cutting off JSON |

### Role 2 — Expansion (on demand)

- **Input:** the validated structured result.
- **Output:** free-text listing description (~150–250 words).
- Distinct prompt (`EXPANSION_SYSTEM_PROMPT`): no markdown, use only supplied
  facts, treat JSON as passive data.

**Config justification** (`AI_CONFIG.expansion`):

| Setting | Value | Why |
|---|---|---|
| `timeoutMs` | `30000` | Enough for a complete 150–250 word listing |
| `maxOutputTokens` | `800` | Comfortably fits a full ~250-word description |
| `temperature` | `0.7` | Natural, engaging marketing prose while staying factual |

### Retry, error typing, and failure semantics

- **Typed errors** (`src/lib/ai/errors.ts`): `ProviderTimeoutError`,
  `ProviderTransientError`, `ProviderPermanentError`, `ValidationError`.
- **Retries** (`RETRY_CONFIG`): `maxAttempts: 3`, backoff `[1000, 3000] ms`.
  - Timeouts / transient errors retry while attempts remain.
  - Validation errors retry **once** with a stricter prompt suffix, then fail.
  - Permanent errors fail immediately.
- The raw provider response is stored on `job.rawModelOutput` (evidence) while
  the validated data is stored on `job.result`.
- Failures are surfaced honestly via a specific `errorMessage`; the worker
  guarantees every path ends in `done` or `failed` (never stuck `processing`).

---

## 9. Background Job Queue & Recovery

- [`src/lib/jobs/queue.ts`](src/lib/jobs/queue.ts) uses `p-limit` with
  `MAX_CONCURRENT_JOBS = 2`, cached on `globalThis` so a single limiter spans the
  process and survives hot reloads. Uploaded jobs are enqueued directly — there
  is no polling-based discovery.
- [`src/lib/jobs/process-job.ts`](src/lib/jobs/process-job.ts) atomically claims
  a job (`pending → processing` via an update-many guard), downloads the image
  from R2, runs the retry loop, and persists results.
- **Startup recovery** ([`src/instrumentation.ts`](src/instrumentation.ts)): on
  boot it resets orphaned `processing` rows back to `pending` and re-enqueues all
  pending jobs. The same file registers an hourly sweep of expired, never-used
  password-reset tokens.
- Caveat: the in-memory queue does not survive serverless runtimes; startup
  recovery only runs on the Node.js runtime.

---

## 10. Security Controls

| Area | Implementation |
|---|---|
| Sessions | 32-byte random token; only its SHA-256 hash stored. HttpOnly, `SameSite=Strict`, `Secure` in production. Idle timeout 30 min + absolute timeout 24 h. |
| Sign-out | Sets `invalidatedAt` server-side and clears the cookie. |
| Password reset | Invalidates **all** the user's sessions; consumes the reset token atomically. |
| Passwords & codes | bcrypt cost factor 10; salts embedded. Both user passwords and 6-digit verification/reset codes are hashed using bcrypt. Verification and reset routes compare against a fixed dummy bcrypt hash for non-existent users or missing tokens to equalize timing (anti-enumeration). |
| Code & token expiry | Verification codes live 60 seconds (`VERIFICATION_CODE_TTL_MS`); password reset tokens live 10 minutes (`RESET_CODE_TTL_MS`), centralized in `src/lib/auth-config.ts`. Single hourly sweeper removes expired rows for both tables. |
| Attempt reservation | Atomic increment-before-compare (`updateMany` with attempt cap & future expiry check) prevents parallel guess racing before running `compareCode`. |
| CSRF | Double-submit cookie: non-HttpOnly `csrf_token` cookie + `x-csrf-token` header, compared constant-time. |
| Rate limiting | DB-backed, per `(identifier, route)`. Exponential backoff after 2 free failures: `2^(n-3)` min, capped at 60 min. Applied to signin, signup, forgot-password, resend, upload, expand. |
| Enumeration | Sign-in, signup, forgot-password, and reset flows return uniform responses; verification/reset codes are hashed and rate-limited. |
| Upload validation | MIME allow-list (`image/jpeg`, `image/png`), size cap (5 MB), count cap (10), and **magic-byte signature checks** before storage. |
| Storage | Randomized opaque R2 keys; only the key is persisted. Orphaned objects are deleted if the DB insert fails. |
| Route protection | [`src/proxy.ts`](src/proxy.ts) redirects unauthenticated requests for `/dashboard`, `/verify-email`, `/upload`, `/jobs`; server components re-validate the session authoritatively. |

### What I chose against

- **HMAC with a server secret for codes:** Fast (SHA-256) and allows indexed lookups, but does not provide work factor against offline brute-forcing if database records leak. Because 6-digit codes have low entropy (1,000,000 combinations), bcrypt's intentional CPU cost (cost factor 10, ~70–100ms) with unique per-row salts prevents offline dictionary/rainbow table attacks, while eliminating server secret management and key-rotation overhead.

### Upload & rate-limit constants (`src/lib/ai/config.ts`)

| Setting | Value |
|---|---|
| Max file size | 5 MB |
| Allowed types | JPEG, PNG |
| Max files per upload | 10 |
| Max concurrent jobs | 2 |
| Upload rate limit | 10 requests / 10 min |
| Expand rate limit | 20 requests / 10 min |

---

## 11. Frontend Routes

| Route | Access | Description |
|---|---|---|
| `/` | Public | Redirects to `/dashboard` or `/verify-email` or `/signin` |
| `/signin` | Public | Sign-in form |
| `/signup` | Public | Registration form with password checklist |
| `/verify-email` | Session | 6-digit email verification with server-synced resend countdown |
| `/forgot-password` | Public | Three-step reset flow (request → verify code → new password) |
| `/dashboard` | Session + verified | Welcome page with a link to Upload |
| `/upload` | Session + verified | Drag-and-drop/browse upload card, recent jobs list with polling |
| `/jobs/[id]` | Session + verified | Structured result view + Expand action |

The auth screens share a client layout ([`src/app/(auth)/layout.tsx`](src/app/(auth)/layout.tsx))
that redirects authenticated users away from public auth pages and unverified
users to `/verify-email`. Client-side auth state lives in
[`src/context/auth-context.tsx`](src/context/auth-context.tsx); API calls go
through [`src/lib/api-client.ts`](src/lib/api-client.ts), which attaches the CSRF
header automatically.

---

## 12. Verifying the Build

```bash
npx tsc --noEmit   # type check
npm run lint       # lint
npm run build      # production build
```

Manual end-to-end check:

1. Sign up → receive/read the verification code (printed to server logs) →
   verify → land on `/dashboard`.
2. Upload a JPEG/PNG → watch the job move `pending → processing → done` in the
   Recent Processing Jobs table.
3. Open the result → view structured fields → click **Expand** → see the longer
   listing.
4. Upload an oversized or non-image file → confirm it is rejected with a reason.
5. Upload ≥10 files at once and observe (server logs) that at most 2 Gemini
   calls run concurrently.

---

## 13. Notes & Conventions

- Config values are centralized in `src/lib/ai/config.ts`; nothing tunable is
  hardcoded in route handlers.
- Secrets live only in `.env` (git-ignored); `.env.example` carries placeholders.
- Code intentionally avoids comments beyond those explaining non-obvious
  security or lifecycle decisions.
- See [`docs/PRD_AI_Integration.md`](docs/PRD_AI_Integration.md) for the
  originating requirements and acceptance criteria.
