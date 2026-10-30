# Recorded purchase revenue release recovery

Checked on 2026-10-29 from the cloud worker using the deployer identity.

## Implementation

Reused original task commit `6960d0f` on the incident branch. Event details now
reuse settlement's `ticketRevenue` helper for sold tier/event revenue and
reserved pending payments. Regression coverage proves repricing stability,
mixed historical amounts, zero amounts, excluded cancelled/refunded tickets,
empty inventory and agreement with organiser earnings. No schema change or
new compatibility behavior was introduced.

`npm run build` and the organiser-event/settlement service suites pass (34 tests).
The branch includes origin/dev `3d08291` as an ancestor. Cloud Build now persists
zero minimum instances at both service and revision level without changing
secret or environment bindings. These flags have not been deployed.

## Remaining runtime blocker

Authenticated dashboard reads confirm original task
`task-1793311453768-to7ubn` exhausted three dev deployment attempts.

Current latest secrets `YEBOTICKETS__DATABASE_URL_DEV` and
`YEBOTICKETS__DIRECT_URL_DEV` both point to
`postgres.omevision.com/yebotickets_dev`, rather than the required Neon database.
The existing YeboTickets secret inventory contains no alternative named Neon
dev database credential. Do not substitute another product's credentials.

Cloud Run `yebotickets-api-dev` serves diagnostic revision
`yebotickets-api-dev-hn1029-5bbfde` at 100% traffic, using the
`postgres-tls-client` image. Runtime identity is
`yebotickets-runtime@hiyebo.iam.gserviceaccount.com`. Its DATABASE_URL binding
is pinned to version 3; the pipeline would bind latest. The public dev `/health`
returns HTTP 503 from the network-enabled worker host.

Do not replace this diagnostic revision blindly or interpret it as deployed API
code. Recover the approved Neon dev pooled/direct credentials and migration
access, coordinate the existing runtime incident, then use the normal review
and deployment stages. No migration, deployment-branch push, secret update or
runtime replacement was performed in this recovery pass.

## Release evidence still required

After access is restored, verify schema compatibility, completed Cloud Build,
the exact application revision and traffic, then authenticated event details
for an existing dedicated test account with known historical ticket amounts.
Compare sold tier totals, total revenue and reserved pending payments with
recorded rows and earnings. A health check alone cannot prove this repair.
Before deployment completion, PATCH the dashboard task verifyCmd with a
read-only assertion of that exact revision and operation. Do not signal
deployment completion or invent live verification while this blocker remains.

## Rework: historical credential recovery

The cloud-worker recheck found enabled version 1 of both approved dev secrets.
They identify the separate Neon endpoint `ep-rapid-brook-agyszm2a` (database
`neondb`); version 1 of the production secrets identifies a different endpoint,
`ep-autumn-pond-ag5w94k8`. No credential values were printed or changed.

A direct `psql` connection using dev DIRECT_URL version 1, TLS, a 15-second
connection timeout and read-only transaction defaults failed with the provider
error: `The endpoint has been disabled. Enable it using the API and retry.`
Thus historical approved credentials exist, but the endpoint cannot currently
serve application or migration queries. The accessible hiyebo secret inventory
has no named Neon management credential. Authorized Neon management access is
needed to enable this existing dev endpoint before checking schema and migration
access; do not create a replacement database or substitute production access.

Authenticated dashboard task/session reads succeeded and were retained locally.
Cloud Run still routes 100% to `yebotickets-api-dev-hn1029-5bbfde`; the worker-host
public dev health probe still returns HTTP 503 `Service is disabled`.
The existing implementation builds and both relevant suites pass (34 tests).
No secret rebinding, migration, runtime replacement, deployment-branch push,
verifyCmd completion assertion or completion signal was performed.

## Access audit: final implementation rework

At 2026-10-29 22:41 UTC, authenticated task and agent-session GETs succeeded
through the escalated worker-host context; JSON responses were retained under
`/tmp/revenue-recovery-{task,sessions}.json`. No stage result was submitted.
The worker environment and `/root/.omevision/env` contain no named Neon
management credential, standard Neon CLI credential locations are absent, and
the accessible hiyebo Secret Manager inventory contains no named Neon management
secret. No connected Neon management tool is available. Other products' database
and infrastructure credentials were not used to bypass this missing access.

A fresh TLS read-only `SELECT 1` using approved dev DIRECT_URL version 1 again
returned Neon's explicit endpoint-disabled error. The worker-host health probe
returned HTTP 503, and Cloud Run still routes 100% to the diagnostic revision
listed above. Build and both relevant suites pass (34 tests). The missing
prerequisite is authorized Neon management access for this existing dev endpoint,
or its re-enablement by an existing authorized operator. Database credentials
alone cannot perform this management operation. Runtime restoration, historical
revenue verification, verifyCmd and stage completion remain pending.

## Cloud-fleet continuation: 2026-10-30

Recovered the existing remote incident branch at `0fd3700` by fast-forward;
this newly provisioned worktree initially tracked only main. No implementation
was rewritten. Build and both revenue/settlement suites pass (34 tests).

Authenticated host-context task and agent-session reads succeeded and were
retained in `/tmp/yebotickets-{task,sessions}.json`. The task is running with
this implementation session; do not redispatch a duplicate. Worker inventory
and worker-session reads also succeeded, but these routes do not expose the
specific job `wjob_c865dd720c030812` status. There is insufficient evidence to
cancel that job; no cancellation or redispatch was attempted.

A fresh explicit TLS, read-only `SELECT 1` against approved dev DIRECT_URL
version 1 reproduced Neon's endpoint-disabled error for
`ep-rapid-brook-agyszm2a`. The hiyebo named Neon management-secret inventory
remains empty. Host-context dev health returns HTTP 503 Service is disabled.
Cloud Run still sends 100% traffic to `yebotickets-api-dev-hn1029-5bbfde` with
runtime identity `yebotickets-runtime@hiyebo.iam.gserviceaccount.com`.

The prerequisite remains authorized management access to enable the existing
Neon dev endpoint, or re-enablement by its authorized operator. No bindings,
production/dev branches, migrations or runtime configuration were changed.
Live historical revenue proof, verifyCmd and completion signalling remain
pending; no stage-result POST was sent.
