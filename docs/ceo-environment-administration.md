# CEO administration environment cutover

The existing owning handlers, source receipts and CEO approval queue remain the
administration flow. The source boundary now derives `yebotickets:prod` or
`yebotickets:dev` from its actual Cloud Run `K_SERVICE` using canonical SDK 0.5.0.
Missing, legacy and other-product service names fail. Old unscoped assertions
are rejected, with no compatibility endpoint or guessed production default.

Review versions include the complete source-owned operation definition as well
as their existing business evidence. A source-definition change after the central
claim fails before the business mutation. Google workload verification derives the audience origin from that exact runtime environment. No caller field or deployment audience override selects it. An absent runtime name fails.

Actual central/source fixtures require an explicit environment and its separately
named local database under a non-superuser, non-BYPASSRLS runtime role. Prod/dev
reuse private record IDs with different labels, reject crossed assertions and
retain the existing money, critical-audit, receipt and stale-review checks. Payment
and notification provider transports remain synthetic; no real funds or messages
are sent. Local roles and injected identities do not prove deployed Neon role
restrictions, real Google workload verification or production operator acceptance.

Read-only inspection found no corporate caller/audience fields in either live
Tickets service. The parent draft appends the verified caller in its additive build config;
this branch removes its prod-default audience substitution and derives prod/dev
audiences from the actual service instead. Both actual
services use the dedicated yebotickets-runtime service account. No live field or
IAM grant was changed during this inspection.

This branch is a coordinated breaking dependency of CEO API draft #251 and the
pending shared frontend cutover. It retains its parent draft's migration and
YeboPay caller-cutover dependencies. Do not deploy it independently or retire a
separate admin before final authenticated operator acceptance. No production
migration, deployment, environment/secret binding or IAM change was made here.
