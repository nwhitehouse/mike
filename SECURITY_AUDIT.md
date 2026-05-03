# Security Audit Notes

Last checked: 2026-05-03

## Frontend npm audit

`npm audit --audit-level=moderate` currently reports only the `uuid <14.0.0`
moderate advisory through transitive dependencies:

- `exceljs@4.4.0 -> uuid@8.3.2`
- `resend -> svix -> uuid@10.0.0`

The reported issue requires callers to pass attacker-controlled buffers into
UUID v3/v5/v6 APIs. This frontend codebase does not call those transitive
UUID APIs directly. `npm audit fix --force` would downgrade `exceljs` to a
breaking old major, so this is intentionally left as a documented moderate
until upstream packages move to `uuid >=14` without a breaking downgrade.

## Backend npm audit

`npm audit --audit-level=moderate` reports zero vulnerabilities after the
dependency updates and overrides in `backend/package.json`.
