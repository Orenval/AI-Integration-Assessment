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
| AI provider | `@google/genai` — Gemini `gemini-3.1-flash-lite` |
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

## 4. How to Run This Project

### Prerequisites

Ensure the following tools, services, and credentials are ready before running the project:

- **Node.js**: `v20.x` or newer (developed and validated on Node.js `v24.16.0`).
- **Package Manager**: `npm` (bundled with Node.js).
- **PostgreSQL Database**: PostgreSQL 14+ running locally (e.g. `localhost:5432`) or hosted remotely (Neon, Supabase, RDS).
- **Google Gemini API Key**: API key configured for Google GenAI Studio (`gemini-3.1-flash-lite`).
- **Cloudflare R2 Object Storage**: Cloudflare account with an R2 bucket and an API token (Account ID, Access Key ID, Secret Access Key).
- **SMTP Service**: Transactional email credentials for 6-digit email OTP delivery (Gmail SMTP with App Password, Ethereal, Mailtrap, or Sendgrid).

---

### Step-by-Step Setup Guide

#### Step 1: Clone & Install Dependencies
Install all production dependencies and TypeScript development tools:

```bash
npm install
```

#### Step 2: Configure Environment Variables
Create your local environment file by copying `.env.example`:

```bash
# Windows (PowerShell or CMD)
copy .env.example .env

# macOS / Linux
cp .env.example .env
```

Open `.env` and fill in all required secrets (see [Section 5](#5-environment-variables) for detailed descriptions):
- Provide your database connection string in `DATABASE_URL`.
- Generate secure 64-character hexadecimal values for `SESSION_SECRET` and `CSRF_SECRET`:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- Enter your `GEMINI_API_KEY`.
- Enter your Cloudflare R2 credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`).
- Enter your SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`).

> **Security Note:** Never commit your `.env` file to version control. The repository's `.gitignore` automatically excludes `.env`.

#### Step 3: Initialize Database Schema & Prisma Client
Synchronize the Prisma schema with your PostgreSQL database and generate the client bindings:

```bash
# Push schema structure, tables, indexes, and constraints to PostgreSQL
npx prisma db push

# Generate typed Prisma client in node_modules/@prisma/client
npx prisma generate
```

*(Alternatively, run `npx prisma migrate deploy` if deploying against formal SQL migrations in CI/CD).*

#### Step 4: Run the Development Server
Start the Next.js development server with Turbopack:

```bash
npm run dev
```

Access the application in your browser at [http://localhost:3000](http://localhost:3000).

#### Step 5: Build and Run in Production
To validate and run an optimized production build:

```bash
# 1. Type check
npx tsc --noEmit

# 2. Lint check
npm run lint

# 3. Compile optimized production bundle
npm run build

# 4. Start production server
npm run start
```

#### Step 6: End-to-End Verification Checklist
1. Visit `http://localhost:3000` — unauthenticated users are redirected to `/signin`.
2. Click **Create account** (`/signup`), fill out the registration form, and submit.
3. Retrieve your 6-digit verification code from your inbox (or check terminal stdout if local) and submit it on `/verify-email`.
4. Once verified, you land on `/dashboard`. Click **Upload Photos** (or visit `/upload`).
5. Drag and drop or browse 1–10 JPEG/PNG photos (≤5MB each). Notice the instant local client-side preview thumbnails.
6. Click **Upload and process**. The form submits immediately (`201 Created`), returns job IDs, and adds the jobs to the "Recent Processing Jobs" table.
7. Observe the adaptive polling engine: status badges transition from `Waiting` (`pending`) → `Working` (`processing`) → `Done` (`done`).
8. Notice that polling halts automatically as soon as all jobs finish.
9. Click any completed job card to view `/jobs/[id]`.
10. Click **Expand description** to run the on-demand Gemini listing generation and view the completed marketing prose.

---

### npm Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start development server with Turbopack |
| `npm run build` | Compile optimized production build |
| `npm run start` | Serve production build |
| `npm run lint` | Run ESLint across all files |
| `npm run lint:fix` | Run ESLint with automatic fixes |

---

## 5. Environment Variables

| Variable | Required | Description | Example / Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://postgres:password@localhost:5432/ai_integration_assessment?schema=public` |
| `SMTP_HOST` | Yes | SMTP host for transactional email | `smtp.gmail.com` or `smtp.mailtrap.io` |
| `SMTP_PORT` | Yes | SMTP port | `465` (SSL) or `587` (STARTTLS) |
| `SMTP_USER` | Yes | SMTP username | Account email or API user |
| `SMTP_PASS` | Yes | SMTP password | App Password (Gmail) or SMTP token |
| `SMTP_FROM` | No | Sender From header | `AI Assessment <noreply@example.com>` |
| `SESSION_SECRET` | Yes | 32-byte secret for session token derivation | 64-char hex string from `crypto.randomBytes(32)` |
| `CSRF_SECRET` | Yes | 32-byte secret for CSRF token generation | 64-char hex string from `crypto.randomBytes(32)` |
| `NEXT_PUBLIC_APP_URL` | Yes | Public URL of the app | `http://localhost:3000` |
| `GEMINI_API_KEY` | Yes | Google Gemini API key | From Google AI Studio |
| `R2_ACCOUNT_ID` | Yes | Cloudflare account ID | Cloudflare dashboard → R2 overview |
| `R2_ACCESS_KEY_ID` | Yes | S3/R2 access key ID | R2 Manage API Tokens |
| `R2_SECRET_ACCESS_KEY` | Yes | S3/R2 secret access key | R2 Manage API Tokens |
| `R2_BUCKET_NAME` | Yes | Cloudflare R2 bucket name | Target bucket name |

---

## 6. End-to-End Application Flow & Polling Architecture

### Complete System Execution Flow

```
[User Browser]
      │
      ├─ 1. Authentication & Session Initialization
      │       ├── User registers at /signup -> 6-digit code sent via SMTP
      │       ├── Enters OTP at /verify-email -> User.emailVerified set to true
      │       └── Session created -> HttpOnly cookie (session_token) + non-HttpOnly double-submit CSRF cookie (csrf_token)
      │
      ├─ 2. Photo Selection & Pre-Flight Validation (/upload)
      │       ├── User selects 1–10 images (JPEG/PNG, ≤5MB each)
      │       └── Client validates constraints & renders instant previews via URL.createObjectURL()
      │
      ├─ 3. Upload Submission (POST /api/jobs/upload)
      │       ├── Validates session cookie & x-csrf-token header
      │       ├── Checks sliding-window rate limit (10 requests / 10 min window)
      │       ├── Inspects binary magic bytes (JPEG: FF D8 FF / PNG: 89 50 4E 47 0D 0A 1A 0A)
      │       ├── Streams binary image buffer to Cloudflare R2 (uploads/<userId>/<uuid>.<ext>)
      │       ├── Creates Job record in PostgreSQL (status: "pending", stores storageKey only)
      │       ├── Hands job to in-memory queue: enqueueJob(job.id)
      │       └── Returns HTTP 201 Created immediately with job summaries (non-blocking)
      │
      ├─ 4. Background Asynchronous Processing (src/lib/jobs/process-job.ts)
      │       ├── Queue concurrency gate (p-limit, MAX_CONCURRENT_JOBS = 2)
      │       ├── Atomic claim: UPDATE Job SET status="processing" WHERE status="pending"
      │       ├── Retrieves image buffer from Cloudflare R2
      │       ├── Calls Gemini 3.1 Flash Lite with EXTRACTION_SYSTEM_PROMPT & JSON schema
      │       ├── Validates output against Zod extractionResultSchema (title, description, category, tags)
      │       ├── Retry loop on transient/timeout errors (up to 3 attempts, backoff [1s, 3s])
      │       ├── Persists result & rawModelOutput JSON on Job row
      │       └── Sets Job status to "done" (or "failed" with user-safe errorMessage)
      │
      ├─ 5. Frontend Adaptive Status Polling (GET /api/jobs)
      │       ├── Polls every 2000 ms (2 seconds) while active jobs exist
      │       └── STOPS when every job reaches a terminal state ("done" or "failed") or component unmounts
      │
      └─ 6. On-Demand Expand Action (POST /api/jobs/[id]/expand)
              ├── User clicks "Expand description" on /jobs/[id]
              ├── Validates session, CSRF, and checks idempotency (returns cached if already expanded)
              ├── Checks sliding-window rate limit (20 requests / 10 min window)
              ├── Concurrency lock per job ID (409 Conflict if duplicate request in flight)
              ├── Calls Gemini with EXPANSION_SYSTEM_PROMPT & structured data
              ├── Persists natural-language listing in Job.expandedResult
              └── Returns HTTP 200 with expanded prose to UI
```

---

### Frontend Polling Lifecycle, Interval & Termination Point

The upload view ([`src/app/upload/upload-view.tsx`](src/app/upload/upload-view.tsx)) manages asynchronous job status updates using a client-side polling engine:

1. **Polled Endpoint**:
   - `GET /api/jobs`: Returns the authenticated user's latest 20 jobs sorted by `createdAt: "desc"`. Each item includes `id`, `status`, `attempts`, `errorMessage`, `originalFileName`, `createdAt`, and `resultTitle`.

2. **Polling Interval**:
   - **Exactly 2,000 milliseconds (2 seconds)** via React `useEffect` and browser `setInterval()`.
   - **Overlap / Stacking Guard (`isPollingRef.current`)**: Before issuing a network fetch, `isPollingRef.current` is inspected. If a previous request is still in flight (e.g. during temporary network latency), subsequent ticks are dropped. This prevents network congestion and socket exhaustion.

3. **Active Polling Condition**:
   - Polling runs if and only if at least one job in the client state is actively executing:
     ```typescript
     const hasActiveJobs = jobs.some(
       (j) => j.status === 'pending' || j.status === 'processing'
     );
     ```

4. **Point Where Polling Stops (Termination Conditions)**:
   - **Condition 1 — Terminal State Resolution**: As soon as every job in the list resolves to a terminal state (`status === 'done'` or `status === 'failed'`), `hasActiveJobs` evaluates to `false`. React tears down the effect and calls `clearInterval(intervalId)`. All polling halts immediately.
   - **Condition 2 — Component Unmount / Navigation**: When the user navigates away from `/upload` (such as clicking a completed job card to view `/jobs/[id]`, returning to `/dashboard`, or signing out), the `useEffect` cleanup function immediately fires `clearInterval(intervalId)`, eliminating orphaned background network timers.
   - **Condition 3 — Tab Teardown**: Closing or refreshing the page terminates the active browser timer.

---

## 7. Data Model, Auth Table Blocks & Constraints

Defined in [`prisma/schema.prisma`](prisma/schema.prisma) and enforced via PostgreSQL relational constraints, indexes, and application-level security invariants.

### Table Blocks

#### Auth Table Block

1. **`User` (Identity Root)**
   - `id`: `String` (CUID, Primary Key)
   - `fullName`: `String` (User's display name)
   - `email`: `String` (Unique email address)
   - `passwordHash`: `String` (bcrypt hash with embedded salt, cost factor 10)
   - `emailVerified`: `Boolean` (Default `false`; set `true` upon 6-digit OTP code verification)
   - `createdAt`: `DateTime` (Default `now()`)
   - `updatedAt`: `DateTime` (Automatic timestamp on modification)
   - *Relations*: Cascading 1-to-many relations with `Session`, `VerificationCode`, `PasswordResetToken`, `Job`.

2. **`Session` (Stateful Authenticated Sessions)**
   - `id`: `String` (CUID, Primary Key)
   - `userId`: `String` (Foreign key -> `User.id`, `ON DELETE CASCADE`)
   - `sessionTokenHash`: `String` (Unique SHA-256 hash of the 32-byte raw cookie token)
   - `createdAt`: `DateTime` (Default `now()`)
   - `lastActivityAt`: `DateTime` (Touched on every authenticated request for idle timeout)
   - `expiresAt`: `DateTime` (Hard absolute session ceiling, 24 hours from creation)
   - `invalidatedAt`: `DateTime?` (Timestamp when user signed out; non-null indicates revoked session)

3. **`VerificationCode` (Email Verification OTP)**
   - `id`: `String` (CUID, Primary Key)
   - `userId`: `String` (Foreign key -> `User.id`, `ON DELETE CASCADE`)
   - `codeHash`: `String` (bcrypt hash of the 6-digit numeric OTP)
   - `expiresAt`: `DateTime` (60-second database-enforced TTL)
   - `consumedAt`: `DateTime?` (Legacy soft-mark; rows are deleted on consumption)
   - `resendCooldownUntil`: `DateTime` (60-second server-enforced cooldown before a new code can be issued)
   - `attemptCount`: `Int` (Default `0`; incremented on wrong guess; lockout at 5)
   - `createdAt`: `DateTime` (Default `now()`)

4. **`PasswordResetToken` (Password Reset OTP)**
   - `id`: `String` (CUID, Primary Key)
   - `userId`: `String` (Foreign key -> `User.id`, `ON DELETE CASCADE`)
   - `codeHash`: `String` (bcrypt hash of the 6-digit numeric OTP)
   - `expiresAt`: `DateTime` (10-minute database-enforced TTL)
   - `usedAt`: `DateTime?` (Legacy soft-mark; rows are deleted on consumption)
   - `resendCooldownUntil`: `DateTime` (60-second server-enforced cooldown)
   - `attemptCount`: `Int` (Default `0`; incremented on wrong guess; lockout at 5)
   - `createdAt`: `DateTime` (Default `now()`)

5. **`RateLimitAttempt` (Auth Brute-Force Lockout Tracker)**
   - `id`: `String` (CUID, Primary Key)
   - `identifier`: `String` (Email address or client IP address)
   - `route`: `String` (Route key: `signin`, `signup`, `forgot-password`, `resend`)
   - `attemptCount`: `Int` (Default `1`; failed attempt counter)
   - `lockedUntil`: `DateTime?` (Lockout timestamp; exponential backoff `2^(n-3)` min, capped at 60 min)
   - `windowStart`: `DateTime` (Sliding baseline; resets after 2 hours of inactivity)
   - `updatedAt`: `DateTime` (Last updated timestamp)

---

#### AI Pipeline Table Block

6. **`Job` (Asynchronous AI Unit of Work)**
   - `id`: `String` (CUID, Primary Key)
   - `userId`: `String` (Foreign key -> `User.id`, `ON DELETE CASCADE`)
   - `status`: `String` (`pending` | `processing` | `done` | `failed`)
   - `attempts`: `Int` (Execution attempts, default `0`, capped at 3)
   - `errorMessage`: `String?` (User-safe error explanation populated on permanent failure)
   - `storageKey`: `String` (Opaque R2 storage key `uploads/<userId>/<uuid>.<ext>`, never the file binary)
   - `originalFileName`: `String` (Original filename)
   - `fileSize`: `Int` (File size in bytes, max 5,242,880)
   - `mimeType`: `String` (`image/jpeg` or `image/png`)
   - `rawModelOutput`: `Json?` (Complete Gemini JSON response payload retained for audit/debugging)
   - `result`: `Json?` (Validated, schema-conformant extraction JSON: title, description, category, tags)
   - `expandedResult`: `String?` (Long natural-language listing generated by the follow-up Expand action)
   - `createdAt`: `DateTime` (Default `now()`)
   - `updatedAt`: `DateTime` (Automatic timestamp on update)

7. **`ApiRequestLog` (Sliding Window AI Rate Limiting)**
   - `id`: `String` (CUID, Primary Key)
   - `userId`: `String` (User identifier for per-user rate limit isolation)
   - `route`: `String` (`upload` | `expand`)
   - `createdAt`: `DateTime` (Timestamp of accepted request, default `now()`)

---

### Database-Level Check Constraints, Keys & Referential Actions

PostgreSQL and Prisma enforce relational integrity and performance indexing via the following table constraints and indexes:

| Table | Constraint / Index Name | Type | Target / Definition | Purpose |
|---|---|---|---|---|
| `User` | `User_pkey` | Primary Key | `PRIMARY KEY ("id")` | Entity identity |
| `User` | `User_email_key` | Unique Constraint | `UNIQUE ("email")` | DB-level duplicate account prevention |
| `Session` | `Session_pkey` | Primary Key | `PRIMARY KEY ("id")` | Entity identity |
| `Session` | `Session_sessionTokenHash_key` | Unique Constraint | `UNIQUE ("sessionTokenHash")` | Prevents token collision / session takeover |
| `Session` | `Session_userId_fkey` | Foreign Key | `FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE` | Automatic cascade on user account deletion |
| `Session` | `Session_userId_idx` | B-Tree Index | `("userId")` | Fast session lookup per user |
| `VerificationCode` | `VerificationCode_pkey` | Primary Key | `PRIMARY KEY ("id")` | Entity identity |
| `VerificationCode` | `VerificationCode_userId_fkey` | Foreign Key | `FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE` | Automatic cascade on user account deletion |
| `VerificationCode` | `VerificationCode_userId_idx` | B-Tree Index | `("userId")` | Fast pending code lookup |
| `PasswordResetToken`| `PasswordResetToken_pkey` | Primary Key | `PRIMARY KEY ("id")` | Entity identity |
| `PasswordResetToken`| `PasswordResetToken_userId_fkey` | Foreign Key | `FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE` | Automatic cascade on user account deletion |
| `PasswordResetToken`| `PasswordResetToken_userId_idx` | B-Tree Index | `("userId")` | Fast reset token query |
| `RateLimitAttempt` | `RateLimitAttempt_pkey` | Primary Key | `PRIMARY KEY ("id")` | Entity identity |
| `RateLimitAttempt` | `RateLimitAttempt_identifier_route_key` | Unique Constraint | `UNIQUE ("identifier", "route")` | Atomic upsert target for auth failure counters |
| `Job` | `Job_pkey` | Primary Key | `PRIMARY KEY ("id")` | Entity identity |
| `Job` | `Job_userId_fkey` | Foreign Key | `FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE` | Automatic cascade on user account deletion |
| `Job` | `Job_userId_idx` | B-Tree Index | `("userId")` | Fast job list scoping per user |
| `Job` | `Job_status_idx` | B-Tree Index | `("status")` | Fast worker query & startup recovery sweep |
| `ApiRequestLog` | `ApiRequestLog_pkey` | Primary Key | `PRIMARY KEY ("id")` | Entity identity |
| `ApiRequestLog` | `ApiRequestLog_userId_route_createdAt_idx` | Compound Index | `("userId", "route", "createdAt")` | High-speed sliding-window counting |
| `ApiRequestLog` | `ApiRequestLog_createdAt_idx` | B-Tree Index | `("createdAt")` | High-speed hourly sweeper cleanup |

---

### Application-Level Check Constraints & Security Invariants

In addition to relational database constraints, strict integrity invariants are enforced across application handlers and workers:

1. **Job Status State Machine Invariant**:
   - `status` is strictly restricted to `'pending' | 'processing' | 'done' | 'failed'`.
   - Transitions are atomic: worker claims a job via `prisma.job.updateMany({ where: { id, status: 'pending' }, data: { status: 'processing' } })`. If `count === 0`, duplicate worker execution is impossible.

2. **File Size & Batch Constraints**:
   - Single file size ceiling: `fileSize <= 5,242,880` bytes (5 MB). Enforced both in browser client and in `POST /api/jobs/upload`.
   - Batch count ceiling: `files.length <= 10` files per upload payload.
   - Non-empty check: `fileSize > 0` bytes (0-byte empty files are rejected).

3. **MIME Type & Binary Magic-Byte Constraints**:
   - MIME allow-list: Strictly `'image/jpeg'` or `'image/png'`.
   - Magic-byte binary verification ([`src/app/api/jobs/upload/route.ts`](src/app/api/jobs/upload/route.ts)):
     - JPEG: First 3 bytes must match `0xFF 0xD8 0xFF`.
     - PNG: First 8 bytes must match `0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A`.
     - Renamed or spoofed file extensions are rejected immediately before touching Cloudflare R2.

4. **OTP Attempt & Lockout Invariants**:
   - Maximum attempt ceiling: `attemptCount < 5`. On the 5th failed guess, the code is locked out (`429 Too Many Requests`).
   - Atomic reservation: `updateMany` increments `attemptCount` *before* running `bcrypt.compare` to prevent parallel timing race attacks.
   - Resend cooldown constraint: `now() >= resendCooldownUntil`. Re-requesting codes before the 60-second window expires returns `429` with `Retry-After`.
   - Expiration constraint: `now() <= expiresAt`. Verification codes expire in 60 seconds; reset codes expire in 10 minutes.

5. **Session Lifecycle Invariants**:
   - Idle timeout constraint: `now() - lastActivityAt < 30 * 60 * 1000` (30 minutes).
   - Absolute timeout constraint: `now() < expiresAt` (24 hours maximum lifespan).
   - Explicit invalidation: `invalidatedAt IS NULL`. Sign-out marks `invalidatedAt = now()`.

6. **Sliding Window AI Rate Limiting Invariants**:
   - Upload ceiling: Max 10 upload requests per 10-minute rolling window per user.
   - Expand ceiling: Max 20 expand requests per 10-minute rolling window per user.
   - Emits standard RFC 6585 response headers (`Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`).

---

## 8. API Reference

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

## 9. AI Pipeline

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

## 10. Background Job Queue & Recovery

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
  password-reset tokens and expired API request logs.
- Caveat: the in-memory queue does not survive serverless runtimes; startup
  recovery only runs on the Node.js runtime.

---

## 11. Security Controls

| Area | Implementation |
|---|---|
| Sessions | 32-byte random token; only its SHA-256 hash stored. HttpOnly, `SameSite=Strict`, `Secure` in production. Idle timeout 30 min + absolute timeout 24 h. |
| Sign-out | Sets `invalidatedAt` server-side and clears the cookie. |
| Password reset | Invalidates **all** the user's sessions; consumes the reset token atomically. |
| Passwords & codes | bcrypt cost factor 10; salts embedded. Both user passwords and 6-digit verification/reset codes are hashed using bcrypt. Verification and reset routes compare against a fixed dummy bcrypt hash for non-existent users or missing tokens to equalize timing (anti-enumeration). |
| Code & token expiry | Verification codes live 60 seconds (`VERIFICATION_CODE_TTL_MS`); password reset tokens live 10 minutes (`RESET_CODE_TTL_MS`), centralized in `src/lib/auth-config.ts`. Single hourly sweeper removes expired rows for both tables. |
| Attempt reservation | Atomic increment-before-compare (`updateMany` with attempt cap & future expiry check) prevents parallel guess racing before running `compareCode`. |
| CSRF | Double-submit cookie: non-HttpOnly `csrf_token` cookie + `x-csrf-token` header, compared constant-time. |
| Rate limiting | **Auth endpoints:** DB-backed exponential backoff lockout after 2 free failures: `2^(n-3)` min, capped at 60 min (signin, signup, forgot-password, resend).<br>**AI endpoints:** DB-backed sliding window counter (`ApiRequestLog`) enforcing 10 req/10 min for upload and 20 req/10 min for expand, emitting RFC 6585 headers (`Retry-After`, `X-RateLimit-*`). |
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

## 12. Frontend Routes

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

## 13. Verifying the Build

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

## 14. Notes & Conventions

- Config values are centralized in `src/lib/ai/config.ts`; nothing tunable is
  hardcoded in route handlers.
- Secrets live only in `.env` (git-ignored); `.env.example` carries placeholders.
- Code intentionally avoids comments beyond those explaining non-obvious
  security or lifecycle decisions.
- See [`docs/PRD_AI_Integration.md`](docs/PRD_AI_Integration.md) for the
  originating requirements and acceptance criteria.
