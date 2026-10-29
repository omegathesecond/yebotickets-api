# Error monitoring repair — BLOCKED, not deployed

Investigation on 2026-10-29 from the cloud fleet. No credentials or customer payloads are recorded here.

## Verified evidence

- No prior remote incident branch existed in any of the five component repos. API task branch started at freshly fetched production `3d4a328e577a75f840e2cb3a5a8ab337f0f11356`.
- All five components lacked Sentry SDK/reporting code. Cloud Run production had no Sentry environment binding. A zero-issue scan does not establish coverage.
- Existing approved operations credential: `CEODASHBOARD__SENTRY_OPS_TOKEN`; Sentry organization `hiyebo`; scopes exactly `event:read`, `org:read`, `project:read`. Its organization project registry contained HeyGeorge and seven YeboLearn projects, no YeboTickets project. Do not broaden these scopes.
- Existing separate setup credential `CEODASHBOARD__SENTRY_AUTH_TOKEN` has project administration scopes, but POST `/api/0/teams/hiyebo/hiyebo/projects/` for `yebotickets-api` was refused with HTTP 403: `Your organization has disabled this feature for members.` No project or DSN was obtained. An organization owner must provision this project under the existing hiyebo team, or supply an existing approved product project/DSN. Do not change organization policy or credential roles to bypass this.
- Cloud Run `yebotickets-api-prod`, hiyebo/europe-west1: runtime identity `yebotickets-runtime@hiyebo.iam.gserviceaccount.com`; Ready revision `yebotickets-api-prod-00029-cdw` had 100% traffic. Image was `europe-west1-docker.pkg.dev/hiyebo/cloud-run-source-deploy/postgres-tls-client:7310bf8ce79ecb8a-20261028`, not the production Git SHA image. `/health` returned HTTP 200 with database connected. This does not prove ticketing routes or monitoring work. Coordinate with the existing production incident; do not blindly replace its database/TLS mitigation.

## Prepared API change (must not merge/deploy yet)

Uses the existing HeyGeorge approach: Node SDK, default integrations disabled except fatal exception/rejection capture, no tracing/breadcrumbs, and an allowlist rebuilt event body. Customer text, user data, requests, URLs, extras and arbitrary tags are excluded. Captures HTTP 5xx, health and startup errors. Existing internal API-key middleware protects POST `/api/internal/monitoring-probe`; its fixed synthetic error has no customer input. The route returns an event ID only after SDK flush; provider readback is still required to prove ingestion.

Deployment adds only SENTRY_DSN to existing bindings, environment metadata, and zero minimum instances. Production intentionally refuses to start without its DSN. **The referenced `YEBOTICKETS__SENTRY_DSN` secret does not yet exist: deploying this draft would fail.** No secret, IAM, trigger, service configuration or deployed image was changed in this task.

## Resume and verification gate

1. Obtain the organization-owner-provisioned `hiyebo/yebotickets-api` project and its ingestion DSN. Confirm the existing operations token can read the project without permission changes.
2. Store the DSN in Secret Manager without logging it. Recheck the target service's actual runtime SA and grant accessor only for that secret. Preserve every other binding. Configure dev trigger `_SENTRY_ENVIRONMENT=development` before a dev rollout; do not mislabel dev events as production.
3. Finish regression coverage for the protected HTTP probe and 5xx middleware; assess browser/admin/customer/scanner coverage explicitly. These components remain uninstrumented. Do not run/build Flutter.
4. Review the task branch, reconcile the separate production diagnostic-image incident, and use the normal review/deploy pipeline. Verify pushed SHA, successful build, exact Ready image/revision and 100% traffic independently. Persist both service/revision minimum instances as zero if service-level minimums exist. Preserve database TLS requirements.
5. Invoke the authenticated fixed probe on the deployed API with an internal key fetched privately. Record returned eventId and revision. Using only the operations read token, GET `/api/0/projects/hiyebo/yebotickets-api/events/<eventId>/`; assert exact event ID, project, revision release, environment `production`, operation `controlled-probe`, and absence of user/request/breadcrumb/client fields. Do not paste full event bodies into task notes. Test the unauthenticated probe returns 401 without sending an event.
6. Before deployment completion, PATCH this existing task's verifyCmd to a read-only assertion of Cloud Run SHA/image/traffic/minimums plus that exact Sentry receipt via the existing operations token. The assertion must fail if anything is missing; it must not generate new events. No verifyCmd claiming completion was installed while access is blocked.

No controlled receipt exists yet. Live monitoring is MISSING/UNVERIFIED. This document and draft tests are not proof of deployed coverage. Do not signal done while these blockers remain.

Local validation: Prisma client generation and `npm run build` passed; all three focused monitoring regressions passed (PII allowlist, probe failure behavior, missing production configuration). No provider ingestion test could run.
Full regression validation subsequently passed outside the sandbox (existing HTTP tests require localhost listeners): 30 suites, 492 tests. Initial sandbox run was blocked by listen EPERM; no production dependency calls were needed for validation.
