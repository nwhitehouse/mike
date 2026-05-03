# Security Hardening Rollout

Last updated: 2026-05-03

This document summarizes the non-production hardening pass, the verification
already run, and the next steps required before promoting these changes.

## What Changed

### Secrets and logging

- Removed raw Claude stream persistence and deleted the generated
  `backend/claude-raw-stream.log` artifact.
- Removed verbose backend logs that could expose prompts, document text,
  model outputs, or generated-document content.
- Made download links fail closed unless `DOWNLOAD_SIGNING_SECRET` is set to
  a strong value of at least 32 characters.
- Removed the previous download-token fallback to `SUPABASE_SECRET_KEY` and
  `"dev-secret"`.
- Updated `backend/.env.example` with required hardening settings:
  `DOWNLOAD_SIGNING_SECRET`, `JSON_BODY_LIMIT`, `MAX_CONCURRENT_UPLOADS`, and
  `ADDITIONAL_CORS_ORIGINS`.

### Authorization and tenant isolation

- Fixed `POST /chat/create` so user-supplied `project_id` values must belong
  to a project the caller owns or has been shared into.
- Added tabular review document-ID checks so review creation, review updates,
  cell regeneration, and tabular chat context cannot pull in documents outside
  the caller's accessible tenant/project scope.
- Added an incremental Supabase RLS migration:
  `backend/migrations/002_enable_rls_tenant_tables.sql`.
- The RLS migration enables policies for tenant-sensitive tables including
  projects, folders, documents, document versions, document edits, chats, chat
  messages, workflows, workflow shares, tabular reviews, tabular cells, and
  tabular review chats/messages.

### HTTP and upload controls

- Added `helmet` security headers.
- Replaced broad preview-domain CORS allowance with explicit configured
  origins. Localhost remains allowed only outside production.
- Reduced the default JSON body limit to `2mb`, configurable through
  `JSON_BODY_LIMIT`.
- Added upload concurrency limiting with clear `429` responses.
- Existing Multer file-size enforcement still returns `413` for oversized
  uploads.

### Frontend rendering and client boundary

- Removed the unused frontend S3/R2 helper and direct frontend AWS SDK
  dependencies so browser code no longer contains a storage credential path.
- Changed `frontend/src/lib/supabase-server.ts` to fail closed when required
  server auth configuration is missing.
- Added markdown URL filtering for all ReactMarkdown renderers under
  `frontend/src/app/components`.
- Added rendered DOCX HTML sanitization to remove scriptable attributes,
  script-like elements, and unsafe JavaScript URLs.

### Dependencies

- Updated/pinned backend dependency versions and overrides to clear high and
  critical audit findings.
- Removed direct frontend AWS SDK dependencies and pinned vulnerable transitive
  parser/rendering dependencies through package overrides.
- Documented the remaining frontend moderate `uuid` transitive advisory in
  `SECURITY_AUDIT.md`.

## Verification Run

These commands were run after the hardening changes:

```bash
npm --prefix backend test
npm --prefix backend run build
npm --prefix backend audit --audit-level=moderate
npm --prefix frontend exec tsc -- --noEmit --pretty false
npm --prefix frontend run build
npm --prefix frontend audit --audit-level=moderate
```

Results:

- Backend tests passed: 9 tests.
- Backend TypeScript build passed.
- Backend audit passed with zero vulnerabilities.
- Frontend TypeScript check passed.
- Frontend production build passed.
- Frontend audit still reports only the documented moderate transitive `uuid`
  advisory. See `SECURITY_AUDIT.md`.

`npm run lint --prefix frontend` was also run. It still fails on existing
repo-wide lint issues that are unrelated to this hardening pass.

## Local-Then-Production Demo Checklist

There is no staging environment for this demo app. Treat production as the
rollout target, but test locally before pushing and keep the production
sequence tight and reversible.

Before pushing this branch:

1. Run the local verification commands:
   - `npm --prefix backend test`
   - `npm --prefix backend run build`
   - `npm --prefix frontend exec tsc -- --noEmit --pretty false`
   - `npm --prefix frontend run build`
2. Run a local dev smoke test:
   - start backend and frontend dev servers;
   - sign in with a demo user;
   - upload/open a document;
   - create a chat and a project;
   - create a tabular review with known-accessible documents.

Before deploying production:

3. Set `DOWNLOAD_SIGNING_SECRET` in the backend production environment.
   Generate a random secret with at least 32 characters.
4. Set production CORS explicitly:
   - `FRONTEND_URL=https://www.tryolava.ai`
   - `ADDITIONAL_CORS_ORIGINS=` only for known extra production origins.
5. Confirm operational limits:
   - `JSON_BODY_LIMIT=2mb` unless a reviewed endpoint requires more.
   - `MAX_CONCURRENT_UPLOADS=3` or another capacity-tested value.
6. Take a Supabase backup or snapshot/export before applying the RLS migration.
7. Deploy the backend and frontend changes.
8. Apply `backend/migrations/002_enable_rls_tenant_tables.sql` to Supabase.
9. Run the production smoke test immediately:
   - sign in as user A and upload a standalone document;
   - create a project and share it with user B;
   - confirm user B can access shared project docs/chats;
   - confirm unrelated user C cannot access project, chat, document, tabular
     review, workflow, or download URLs by ID;
   - confirm a generated download link still works for an authorized user and
     fails for an unrelated user.
10. Re-run the verification commands above after production environment variables
   are in place.

## Next Step

The next step is local dev validation, then a direct production demo rollout:

1. Run the local verification commands and local smoke test.
2. Push the branch.
3. Set the new backend env vars, especially `DOWNLOAD_SIGNING_SECRET`.
4. Deploy the code.
5. Apply `backend/migrations/002_enable_rls_tenant_tables.sql`.
6. Run the three-user smoke test: owner, shared collaborator, unrelated user.

If anything breaks, first roll back the app deploy. If the issue is isolated
to RLS, disable RLS on the affected table temporarily while preserving the
app-layer authorization checks, then fix the policy before re-enabling it.

## Remaining Follow-Ups

- Add live Supabase integration tests for RLS read/write/delete denial with
  normal user JWTs.
- Add broader route-level IDOR tests for documents, workflows, projects,
  tabular review chats, downloads, and generated document/version flows.
- Clean up existing frontend lint debt so `npm run lint --prefix frontend`
  becomes a required release gate.
- Monitor upstream packages for a non-breaking fix to the frontend transitive
  `uuid` advisory.
