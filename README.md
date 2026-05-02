# Olava

AI legal platform for in-house and outside counsel: chat over your documents, run tabular extractions across whole sets, draft documents with tracked changes, and route everything through a single fine-tuned legal-tuned model (`Olava-001`).

> Repo history: this codebase started life as `willchen96/mike` (an open-source legal-AI scaffold), was forked and rebranded **Mike → Finch → Olava**. References to the original "Mike" name remain in internal type aliases (`MikeMessage`, `MikeChat`, etc.) and the GitHub repo slug. Renaming those is a tracked-but-deferred chore — see [Known follow-ups](#known-follow-ups).

---

## Table of contents

- [What's in here](#whats-in-here)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Local development](#local-development)
- [Production deployment](#production-deployment)
- [Domain & email setup (`tryolava.ai`)](#domain--email-setup-tryolavaai)
- [Auth, RLS, and the email-domain whitelist](#auth-rls-and-the-email-domain-whitelist)
- [Models & the Olava-001 backend](#models--the-olava-001-backend)
- [Storage](#storage)
- [Common gotchas](#common-gotchas)
- [Testing changes](#testing-changes)
- [Known follow-ups](#known-follow-ups)
- [License](#license)

---

## What's in here

A two-process app with a managed-services back-end:

- `frontend/` — Next.js 16 app (React 19, App Router). Auth UI, chat, tabular review with editable cells and a 3-pane doc viewer, workflows, account settings.
- `backend/` — Express 4 API. Document ingest, LibreOffice DOC/DOCX→PDF conversion, model dispatch, tracked-change DOCX generation, Supabase JWT verification on every request.
- `backend/migrations/` — One-shot Supabase schema (`000_one_shot_schema.sql`) plus an idempotent email-domain whitelist trigger (`001_email_domain_whitelist.sql`). Apply by pasting into the Supabase SQL editor.
- `assets/` — Brand assets (the `ONIT_Mark_Dark.svg` logo lives here and is also copied into `frontend/public/onit-mark-dark.svg`).
- `supabase/` — Reserved for local Supabase CLI configs (used during early local-dev experimentation; the production setup is Supabase Cloud).

There is no monorepo tooling (no Turborepo, no workspaces). Each side has its own `package.json` and is deployed independently.

---

## Architecture

```
                    ┌────────────────────────────────┐
   Browser ─HTTPS─► │  Vercel  ─  Next.js frontend   │
                    │  www.tryolava.ai               │
                    └──────────┬─────────────────────┘
                               │ fetch
                               ▼
                    ┌────────────────────────────────┐
                    │  Railway  ─  Express backend   │
                    │  api.tryolava.ai               │
                    │  (LibreOffice via Nixpacks)    │
                    └──────┬───────────┬─────────┬───┘
                           │           │         │
                  Supabase JWT     S3 SDK    OpenAI-
                    + RLS         (Storage)  compatible
                           │           │         │
                           ▼           ▼         ▼
                    ┌──────────┐  ┌────────┐  ┌─────────────┐
                    │ Supabase │  │Supabase│  │ vLLM/RunPod │
                    │ Postgres │  │Storage │  │  Olava-001  │
                    │ + Auth   │  │  (S3)  │  │ (Qwen+LoRA) │
                    └──────────┘  └────────┘  └─────────────┘
                           ▲
                           │ SMTP (auth emails)
                           │
                    ┌──────────────┐
                    │   Resend     │
                    │ mail.tryolava.ai
                    └──────────────┘
```

**Why these choices:**
- **Supabase** for DB + Auth + Storage — one provider, RLS keeps multi-tenant queries safe without writing per-route auth.
- **Vercel** for the frontend — Next.js 16's native target, preview deploys per branch.
- **Railway** for the backend — needs a long-lived process and **LibreOffice** (for DOC/DOCX → PDF). Railway's Nixpacks reads `backend/nixpacks.toml` and installs `libreoffice` as a system package automatically.
- **Resend** for transactional auth emails — straightforward DKIM+SPF setup; SMTP creds plug straight into Supabase.
- **vLLM on RunPod** for the model — running a fine-tuned LoRA over a 35B base requires a GPU; this is the cheapest "always-on" option that supports OpenAI-compatible streaming + tool calls.

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 16 · React 19 · TailwindCSS 4 · Tiptap (rich text) · pdf.js · TypeScript 5 |
| Backend | Express 4 · TypeScript 5 (`tsx watch` in dev) · Multer (uploads) · libreoffice-convert · jszip · fast-xml-parser |
| Database | Postgres 15 (Supabase) with RLS on every user-owned table |
| Auth | Supabase Auth (email/password, email confirmation toggleable) |
| Storage | Supabase Storage via S3 protocol (`@aws-sdk/client-s3`, path-style) |
| LLM | Olava-001 — `Qwen/Qwen3.6-35B-A3B` + `olava-extract` LoRA, served on vLLM with `--enable-auto-tool-choice --tool-call-parser hermes` |
| Email | Resend SMTP, sender `noreply@mail.tryolava.ai` |
| CI/CD | Auto-deploy on `git push origin main` (both Vercel + Railway watch the repo) |

---

## Project layout

```
mike/                       (repo slug; product name is Olava)
├── frontend/
│   ├── src/app/
│   │   ├── (pages)/        protected pages (assistant, projects, tabular-reviews, workflows, account)
│   │   ├── login/, signup/ public auth pages
│   │   ├── components/     feature components grouped by area (assistant/, tabular/, workflows/, …)
│   │   ├── contexts/       AuthContext, UserProfileContext, ChatHistoryContext
│   │   ├── lib/            modelAvailability, supabase clients, fetch wrappers
│   │   └── layout.tsx, page.tsx
│   ├── public/             onit-mark-dark.svg, favicons
│   ├── .npmrc              `legacy-peer-deps=true` (Vercel install needs this — see Common gotchas)
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── index.ts        Express bootstrap, multi-origin CORS
│   │   ├── routes/         chat, projects, projectChat, documents, tabular, workflows, user, downloads
│   │   ├── lib/
│   │   │   ├── llm/        provider dispatch (claude.ts, gemini.ts, olava.ts, models.ts, types.ts)
│   │   │   ├── chatTools.ts, docxTrackedChanges.ts, convert.ts, …
│   │   │   ├── storage.ts  S3 SDK against Supabase Storage / R2 / MinIO
│   │   │   └── supabase.ts service-role client
│   │   └── middleware/auth.ts  Supabase JWT verification
│   ├── migrations/
│   │   ├── 000_one_shot_schema.sql      tables + RLS + handle_new_user trigger
│   │   └── 001_email_domain_whitelist.sql  signup domain restriction
│   ├── nixpacks.toml       `aptPkgs = ["libreoffice"]`
│   └── package.json        engines.node >= 20
│
├── assets/                 ONIT_Mark_Dark.svg, source assets
├── supabase/               (legacy local-dev configs)
└── README.md               you are here
```

---

## Local development

Tested on macOS 14 / Node 20+. Bun also works but the deploy targets npm.

### Prerequisites

- Node 20+
- A Supabase project (free tier is fine) **or** the [Supabase CLI](https://supabase.com/docs/guides/cli) for fully-local dev
- An S3-compatible bucket (Supabase Storage, MinIO locally, or Cloudflare R2)
- LibreOffice installed locally (`brew install --cask libreoffice` on macOS) — needed for DOCX→PDF
- Olava credentials: a vLLM endpoint URL + bearer token (or any OpenAI-compatible model server)

### One-time setup

```bash
git clone https://github.com/nwhitehouse/mike.git
cd mike

npm install --prefix backend
npm install --prefix frontend

cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Open `backend/.env` and fill in Supabase + storage + Olava values. The frontend only needs `NEXT_PUBLIC_*` vars and the Supabase service-role key (used only in server components).

In the Supabase SQL editor, run **both** migrations in order:
1. `backend/migrations/000_one_shot_schema.sql`
2. `backend/migrations/001_email_domain_whitelist.sql`

### Running

```bash
npm run dev --prefix backend     # → http://localhost:3001 (or PORT in .env)
npm run dev --prefix frontend    # → http://localhost:9000
```

The frontend dev port is **9000** (not 3000) because the project ran a parallel local stack experiment with MinIO + Supabase CLI on adjacent ports. Production uses `:3000`-equivalent Vercel routing, no conflict.

### Quick checks

```bash
npm run build --prefix backend       # tsc emit
npm run build --prefix frontend      # next build
npm run lint --prefix frontend       # eslint
curl http://localhost:3001/health    # → {"ok":true}
curl http://localhost:3001/user/server-keys  # → {"claude":…,"gemini":…,"olava":true}
```

---

## Production deployment

The whole stack is wired for hands-off auto-deploy on `git push origin main`. Each service watches its own subdirectory of the repo.

### Frontend → Vercel

- **Root Directory**: `frontend`
- **Framework**: Next.js (auto-detected)
- **Install command**: default (Vercel reads `.npmrc` for `legacy-peer-deps=true`)
- **Build command**: default (`next build`)
- **Environment Variables**:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` (anon)
  - `SUPABASE_SECRET_KEY` (service role — server-only)
  - `NEXT_PUBLIC_API_BASE_URL` = `https://api.tryolava.ai`

Vercel team settings to watch:
- **"Require Verified Commits"** must be **off** (or per-project override) — otherwise Claude/CI commits get silently rejected from the deploy queue.
- **Vulnerable-package blocking** — Vercel's security scanner refuses to deploy known-bad versions of Next.js (and friends). Bump promptly when warnings appear; don't try to override.

### Backend → Railway

- **Root Directory**: `backend`
- **Builder**: Nixpacks (default). Reads `backend/nixpacks.toml` for the LibreOffice apt layer.
- **Start command**: `npm run start`
- **Generated domain** routed at `api.tryolava.ai` via custom domain.
- **Environment Variables** (subset — full list in `backend/.env.example`):
  - `PORT=3001` (Railway also injects this, but explicit is fine)
  - `FRONTEND_URL=https://www.tryolava.ai`
  - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
  - `R2_ENDPOINT_URL`, `R2_REGION`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (these are S3-protocol vars; against Supabase Storage point at `https://<project>.storage.supabase.co/storage/v1/s3` and set `R2_REGION=<your-region>`, e.g. `us-west-2`)
  - `OLAVA_BASE_URL`, `OLAVA_AUTH_TOKEN`, `OLAVA_ENABLE_TOOLS=true`, `OLAVA_MAX_TOKENS=128000`
  - `RESEND_API_KEY` (only if backend triggers transactional emails — Supabase handles signup/auth emails directly)

Important Nixpacks notes:
- Use `aptPkgs` (additive), not `nixPkgs` (replaces Node detection and breaks `npm ci`).
- The backend `package.json` declares `"engines": { "node": ">=20" }`. Railway dropped Node 18 from the auto-detect pool; without this pin builds fail.

### Database/Auth/Storage → Supabase Cloud

- One project. The free tier handles the legal-team demo comfortably.
- **Authentication → URL Configuration** must list every host the app is served from:
  - Site URL: `https://www.tryolava.ai`
  - Redirect URLs: `https://www.tryolava.ai/**`, `https://*.vercel.app/**`, `http://localhost:9000/**`
- **Authentication → SMTP Settings** uses Resend (see [Domain & email setup](#domain--email-setup-tryolavaai)).
- **Storage** uses the S3 API. Backend hits it via `@aws-sdk/client-s3` with `forcePathStyle: true`.

### Email → Resend

- Domain verified at `mail.tryolava.ai` (DKIM CNAMEs + SPF TXT in GoDaddy DNS).
- Supabase SMTP config:
  - Sender email: `noreply@mail.tryolava.ai` (must align with the DKIM-signed subdomain or DMARC fails)
  - Host: `smtp.resend.com` · Port: `465`
  - Username: `resend` (literal) · Password: your `RESEND_API_KEY` value (`re_…`)

---

## Domain & email setup (`tryolava.ai`)

GoDaddy DNS (one-time):

| Host | Type | Value | Purpose |
|---|---|---|---|
| `@` | A | `76.76.21.21` (Vercel) | apex points at frontend |
| `www` | CNAME | `cname.vercel-dns.com` | www points at frontend |
| `api` | CNAME | `<your>.up.railway.app` | backend |
| `mail` | (Resend gives you 3 CNAMEs + 1 TXT) | … | DKIM + SPF for transactional email |
| `_dmarc` | TXT | `v=DMARC1; p=none; aspf=r; adkim=r; rua=mailto:you@onit.com` | apex DMARC, relaxed alignment so subdomain DKIM aligns |

After DNS settles (10–30 min), in Vercel claim `tryolava.ai` + `www.tryolava.ai`; in Railway claim `api.tryolava.ai`; in Resend confirm all rows are green; in Supabase update Site URL + redirects.

---

## Auth, RLS, and the email-domain whitelist

### Signup flow

1. User submits email + password on `/signup`.
2. Frontend pre-flight check: email domain must be one of `onit.com`, `mccarthyfinch.com`, `k1.com`. If not, instant red error.
3. `supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })`.
4. **Hard enforcement** kicks in: the `enforce_email_domain_whitelist` trigger on `auth.users` (from migration `001_…`) re-checks the domain server-side and raises if it's not in the list. This applies to **every** signup path — frontend, Supabase JS client, admin API, dashboard "Add user" button.
5. The `handle_new_user` trigger (in migration `000_…`) creates a `user_profiles` row with the auth user's id.
6. If email confirmation is **on**: Supabase emails the user a confirmation link via Resend. **Caveat:** corporate email gateways (Mimecast in particular) may quarantine the confirmation email until an admin whitelists `mail.tryolava.ai` and Resend's IPs. For the legal-team demo, email confirmation is currently **off** in Supabase to avoid this — the domain whitelist alone is sufficient for the use case.
7. Frontend gets the session and redirects to `/assistant`.

### Updating the allowed-domain list

Edit **both** of these and re-run the SQL:

- `backend/migrations/001_email_domain_whitelist.sql` — `allowed_domains` array (the source of truth)
- `frontend/src/app/signup/page.tsx` — `ALLOWED_EMAIL_DOMAINS` (the UX hint)

The SQL file is `CREATE OR REPLACE … DROP TRIGGER IF EXISTS …` — safe to re-run.

### RLS

Every user-owned table has policies of the form `user_id = auth.uid()`. The backend runs with the service-role key but consciously scopes queries to the authenticated user (resolved from the JWT in `middleware/auth.ts`). The frontend uses the anon key + RLS for direct Supabase reads.

---

## Models & the Olava-001 backend

The product currently exposes a single model: **Olava-001** (model id `olava-extract`).

- **Base**: `Qwen/Qwen3.6-35B-A3B`
- **LoRA**: `olava-extract` — fine-tuned for legal extraction + drafting tasks
- **Server**: vLLM on RunPod, OpenAI-compatible endpoint, `--enable-auto-tool-choice --tool-call-parser hermes`
- **Reasoning fields**: this is a reasoning model. Streaming responses include `delta.reasoning` / `delta.reasoning_content` chunks before any visible content — `backend/src/lib/llm/olava.ts` accumulates reasoning separately and strips inline `<think>...</think>` blocks.
- **Tool-call format**: the LoRA emits a non-Hermes custom format:
  ```
  <tool_call> <function=NAME> <parameter=KEY> VALUE </parameter> </function> </tool_call>
  ```
  vLLM's hermes parser doesn't catch this. We work around it: when tools are enabled, we use the **non-streaming** endpoint and either consume `message.tool_calls` (when vLLM does parse it) or fall back to parsing the custom markup from `message.content` via `parseCustomToolCall()` in `olava.ts`.

### Anthropic / Gemini code paths

The `backend/src/lib/llm/{claude,gemini}.ts` modules and the provider switch in `lib/llm/index.ts` are still present but unreachable from the UI. A defensive coercion in `streamChatWithTools()` and `completeText()` rewrites any non-Olava model id to `DEFAULT_MAIN_MODEL`, so stale `localStorage` or DB rows referencing `gemini-3-flash-preview` etc. don't break chat. Removing these modules is a future cleanup — not done in this pass to keep the diff small.

### Re-enabling multiple providers

If you want Anthropic + Google back as user-selectable models:
1. Add their entries to `MODELS` in `frontend/src/app/components/assistant/ModelToggle.tsx`.
2. Re-add the API-key input UI to `frontend/src/app/(pages)/account/models/page.tsx`.
3. Re-add `updateApiKey()` to `frontend/src/contexts/UserProfileContext.tsx` (deleted in the Olava-only pass).
4. Remove the `coerceToOlava` wrapper in `backend/src/lib/llm/index.ts`.
5. Set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` env vars on Railway.

---

## Storage

The codebase uses S3-compatible storage via the AWS SDK (`@aws-sdk/client-s3`) with `forcePathStyle: true`. Three setups have been verified:

| Setup | `R2_ENDPOINT_URL` | `R2_REGION` |
|---|---|---|
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `auto` |
| Supabase Storage (production) | `https://<project>.storage.supabase.co/storage/v1/s3` | a real region, e.g. `us-west-2` |
| MinIO (local dev) | `http://localhost:9100` | `auto` |

Bucket name is `R2_BUCKET_NAME` (default `mike`). Object keys are namespaced as `documents/<userId>/<docId>/<filename>` and `generated/<userId>/<docId>/<filename>` — see `lib/storage.ts`.

---

## Common gotchas

- **CORS rejecting `www.tryolava.ai`** — `backend/src/index.ts` explicitly allows `tryolava.ai`, `*.tryolava.ai`, `*.vercel.app`, `localhost:9000`, and the `FRONTEND_URL` env. To add a new public host, edit the origin function in `index.ts`.
- **Mimecast killing signup emails** — see [Auth, RLS, and the email-domain whitelist](#auth-rls-and-the-email-domain-whitelist). The current workaround is to leave email confirmation off; long-term ask the corporate IT admin to whitelist `mail.tryolava.ai`.
- **Vercel "Require Verified Commits"** — silently rejects deploys from unsigned commits even though the GitHub status shows green. Disable per-project or sign commits.
- **Vercel vulnerable-Next.js block** — bump `next` promptly when Vercel surfaces a security advisory; don't try to bypass.
- **Nixpacks dropped Node 18** — `backend/package.json` pins `engines.node >= 20`; if you remove that, Railway falls back to Node 16/18 detection and crashes on modern syntax.
- **`legacy-peer-deps`** — Vercel's npm install needs this for the `next@16` + `@opennextjs/cloudflare` peer mismatch. Set in `frontend/.npmrc`.
- **Olava 400 "auto tool choice requires --enable-auto-tool-choice"** — vLLM was started without that flag. Either (a) restart vLLM with `--enable-auto-tool-choice --tool-call-parser hermes`, or (b) set `OLAVA_ENABLE_TOOLS=false` to disable tools entirely.
- **Stale `localStorage` model id** — old sessions may have `mike.selectedModel = "gemini-3-flash-preview"` saved. The backend's `coerceToOlava()` wrapper handles this transparently; users don't need to clear storage.

---

## Testing changes

There is no automated test suite (yet — see [Known follow-ups](#known-follow-ups)). The verification path used during development:

1. `npm run build --prefix backend` — TypeScript compiles cleanly.
2. `npm run build --prefix frontend` — Next.js build + lint passes.
3. Run both dev servers, sign up with a fresh email in incognito, upload a small PDF, run an extraction, ask the assistant to draft an NDA, generate a tracked-change DOCX.
4. Watch backend logs for `[olava] iter=… content_chars=… reasoning_chars=… tool_calls=…` lines — confirms the model is responding and tool calls are being parsed.
5. Smoke-test on the Vercel preview URL before promoting to production.

For UI changes, **start the dev server and click through the actual feature in a browser** before claiming success. The TypeScript compiler proves syntax, not feature behavior.

---

## Known follow-ups

A backlog for whoever picks this up:

- **Type rename** — internal type aliases (`MikeMessage`, `MikeChat`, `MikeProject`, `MikeDocument`, `MikeCitationAnnotation`, `MikeEditAnnotation`) and drag-and-drop MIME types (`application/mike-doc`, `application/mike-folder`) still use the original "Mike" name. Cosmetic refactor; no functional impact.
- **Repo rename** — the GitHub repo is still `nwhitehouse/mike`. Renaming requires updating Vercel + Railway "GitHub repo" settings to track the new slug.
- **Bucket rename** — `R2_BUCKET_NAME=mike` in production. Renaming the bucket requires a data migration of every storage key.
- **Strip dead Anthropic/Gemini code paths** — `backend/src/lib/llm/{claude,gemini}.ts` and the dispatch in `llm/index.ts` are unreachable from the UI. Safe to delete in one PR; do it when you're confident multi-provider isn't coming back.
- **Custom domain rollout** — the production custom domain (`tryolava.ai`) is wired up. If it ever gets retired, remove the `tryolava.ai` allowance from the CORS origin function in `backend/src/index.ts` and update `FRONTEND_URL` on Railway.
- **Test suite** — no Jest / Vitest / Playwright. Even smoke-test coverage of the chat happy path + tabular extraction would help.
- **Email deliverability for corporate gateways** — long-term, Olava emails should be sent from a domain that already has Mimecast reputation (e.g. an Onit subdomain), not from a freshly-registered `tryolava.ai` subdomain.
- **Observability** — no error tracking (Sentry/Datadog/etc.) and no structured logs. Backend logs are `console.log` strings.

---

## License

[AGPL-3.0-only](LICENSE). Inherited from the upstream `willchen96/mike` repo. Any deployment of a modified version must make the corresponding source available under the same terms.
