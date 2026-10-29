# Exact production runtime error investigation — blocked

Task: incident-1aa43a58e96d4308ab7801be. Investigated from the cloud fleet on 2026-10-29 around 03:36–03:40 UTC. No customer payloads or credentials recorded.

## Exact provider evidence and reproduction

Deployer-authenticated Cloud Logging lookup for insertId `6ae27e95000be40cc0ced123`, service `yebotickets-api-prod`, returned the specified 2026-10-28T23:00:37.779276Z ERROR on revision `yebotickets-api-prod-00029-cdw`. The message is `ApiError: Not found - /`, with its first frame at `notFound` in `/app/dist/middleware/error.middleware.js:24:19`. This is the unmatched-route middleware, not evidence of a failed checkout or database operation.

Fresh read-only public requests reproduced `/` = HTTP 404, success=false, error=`Not found - /`; `/api/events` = HTTP 200, success=true. Response records were inspected only for status/error fields. `src/server.ts` has no root route and mounts `notFound` after API routes. `src/middleware/error.middleware.ts` logs all errors via console.error, including explicit 404s. No fake successful root response or error suppression is justified by this entry. These checks do not establish authenticated checkout or admission success.

## Existing work and deployment

Fetched origin before investigation. Production branch is main, as declared in cloudbuild.yaml and remote HEAD. The local task branch had no changes relative to origin/main, and an explicit `git ls-remote --heads` confirmed no remote branch for this task (ordinary fetch tracks main only).

Read existing related incident branches before proposing changes:

- `incident-d28a0ca583478647b040b627`, commit a4bbf84: docs/incidents/incident-d28a0ca583478647b040b627.md records manifest evidence that the live diagnostic image derives from production build e978624e / main 3d4a328, adding CA installation and Prisma client regeneration. Its existing approved QA-session handoff is still pending. Do not replace this mitigation just because its image name is diagnostic.
- `incident-efcfdd7bba56ec1adad0ff13`, docs/error-monitoring-repair.md: Sentry setup blocked by organization policy; its draft must not deploy without a real DSN.

Fresh Cloud Run describe confirms latest Ready revision 00029-cdw with 100% traffic, image `europe-west1-docker.pkg.dev/hiyebo/cloud-run-source-deploy/postgres-tls-client:7310bf8ce79ecb8a-20261028`, runtime SA `yebotickets-runtime@hiyebo.iam.gserviceaccount.com`. Inspected service/template annotations have no positive minimum-instance setting. No sizing, scaling, secret, environment, database or runtime changes were made.

## Missing verification and handoff

Fresh read-only Sentry GET `/api/0/organizations/hiyebo/projects/` using the approved CEODASHBOARD__SENTRY_OPS_TOKEN returned HTTP 200 with eight projects, no YeboTickets project, and no next results. Thus the exact GCP event cannot be correlated with a YeboTickets Sentry event. Existing owner-provisioned project/DSN blocker remains; do not broaden token scopes or bypass organization policy.

An existing approved QA account/session and frontend target are required for independent authenticated journey verification, as already requested by the related production incident. No payments, admission writes, new accounts, customer-data deletion or Flutter execution occurred.

No actionable runtime failure has been demonstrated by this exact 404 entry. No application repair or deployment is claimed. This evidence branch is preserved for continuation; do not signal done or install a deployment-complete verifyCmd until Sentry access and authenticated verification gates are resolved. An empty later error window is not acceptance evidence.

## Requeue investigation — 2026-10-29 05:33–05:40 UTC

Authenticated host-context dashboard GETs for this task and its agent sessions both returned HTTP 200 with `success: true`; response snapshots are retained in `/tmp/yebotickets-task.json` and `/tmp/yebotickets-sessions.json` on this worker. This rules out current dashboard connectivity as the reason to stop this run. Ordinary sandbox DNS failures are not public-outage evidence.

Recovered the existing remote commit 9674761 through an explicit branch fetch (the repository fetch configuration tracks main only), then fast-forwarded this worktree; prior investigation is preserved.

The preceding session's retained summary reports two launches 58 ms apart and a suspected shared tmux target. That historical causal chain is still not independently proven: old per-launch session directories are no longer present, and the retained worker log inspected here only provides the current launch sequence for this task. Do not present that hypothesis as a confirmed explanation of every earlier exit.

There is now an independently observable fleet change: installed `/root/.claude/bootstrap/omevision-worker/src/session-identity.ts` and its built JS (dated 05:28 UTC) derive the tmux target from both task ID and broker job ID. Installed `handlers.ts` uses that function. Its regression test models delayed predecessor cleanup while a successor runs. `/tmp/omevision-worker.log` records this task starting at 05:33:35.766 UTC as `omevision-task-incident-1aa43a58e96d4308ab7801be-wjob_92ab8ae4fb0b3ff5`, matching that implementation. The task-only-name source in the corporate fleet repository is older than this installed worker; do not reinstall it or duplicate the repair in YeboTickets. This evidence proves the current naming state, not successful completion of a concurrent handoff or the historical root cause.

Fresh authenticated product knowledge lookup returned `success: true` with no testCredentials. Fresh deployer-authorized Sentry project listing returned HTTP 200, eight projects, no YeboTickets project and no next page. These are unresolved access prerequisites, not connectivity errors. An organization owner must provision/expose the YeboTickets project/DSN to the approved operations token, and the QA custodian must supply an approved account/session and frontend target. No token scope expansion was attempted.

No runtime repair, deployment, or authenticated journey success is claimed. No stage-result POST was made; completion remains pending and verifyCmd remains unset because no repaired live operation has been verified.
