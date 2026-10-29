# Root probe incorrectly classified as a runtime crash

## Provider evidence (2026-10-29)

Exact insertId `6ae30ea4000424ae39d70855`, timestamp
`2026-10-29T09:15:16.271534Z`, revision
`yebotickets-api-prod-hn1029-5b4a0f`: `ApiError: Not found - /`.
The adjacent Cloud Run request entry identifies `HEAD /`, HTTP 404,
user agent `OmevisionQAWatch/1.0 (+https://omevision.com)`.
This was an unmatched-route response, not evidence of checkout failure.

Host-context reproduction: root GET 404; `/health` 200 with database connected;
`/api/events` 200. No purchases, customer mutations or admission attempts made.
These reads do not establish that checkout or admission works end-to-end.
The approved Sentry ops token returned HTTP 200 for the hiyebo project list
with no YeboTickets project. Sentry correlation remains unavailable; this
change does not claim to provision monitoring or repair the separate incident.

## Implementation

The shared error handler previously sent every error to stderr. HTTP 4xx
responses now emit an explicit structured WARNING on stdout; failure response
status and body remain intact. Server failures still use console.error.
No successful fallback response or root route is introduced.
Cloud Build persists both service and revision minimum instances at zero.
Existing secret/environment bindings remain additive and unchanged.

Validation: TypeScript build passed and three regression tests passed,
covering the root 404, generic 500 and explicit dependency 503.

## Review / deployment handoff

This is implementation only. Do not treat the pre-change live reads as proof
of deployment. The live revision used a postgres-tls-client diagnostic image
at investigation time, despite serving the API. Coordinate its replacement
with the existing production incident. Deploy only through review and the
main-branch Cloud Build trigger, preserving all runtime bindings.

Before signalling deployment complete, PATCH this task's verifyCmd to a
read-only verifier asserting successful Cloud Build for the merged SHA,
100% traffic to the Ready revision using that image digest, and zero service
and revision minimum instances. Send a uniquely identifiable read-only
HEAD request to an unmatched path; assert HTTP 404 and positively match its
structured WARNING with statusCode 404 in that exact revision's provider logs.
Also assert `/health` 200/database connected and `/api/events` 200.
An empty error window is not verification. Do not log event/customer response
bodies. No Sentry proof is available until the separate monitoring access
blocker is resolved.
