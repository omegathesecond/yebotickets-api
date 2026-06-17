# R2 media storage (ticket QR over WhatsApp)

`src/services/storage.service.ts` (`r2Storage`) uploads the ticket QR PNG to a
public Cloudflare R2 URL so it can be attached to the WhatsApp ticket message via
YeboLink `media_urls` (which takes public URLs, not buffers). If R2 is not
configured, delivery degrades loudly to email — never a silent no-op.

This document records the provisioned infrastructure so the wiring is
reproducible and so a future deploy does not silently drop it.

## Buckets (Cloudflare R2, account `9f15f12d867a59b212ed2ae3cf4615ca`)

| Env  | Bucket                   | Public CDN URL                  |
|------|--------------------------|---------------------------------|
| prod | `yebotickets-media-prod` | `https://cdn.yebotickets.com`     |
| dev  | `yebotickets-media-dev`  | `https://dev-cdn.yebotickets.com` |

Custom domains are attached on Cloudflare (zone `yebotickets.com`). CORS allows
PUT/GET/HEAD from the app/admin origins + localhost. Credentials are a single
**bucket-scoped** R2 S3 token (Object Read+Write on these two buckets only —
never account-wide), minted via the `creating-cloudflare-r2-buckets` skill.

## Env vars the code reads (`storage.service.ts`)

`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET_NAME`,
`R2_PUBLIC_URL`. The same env-var names are used in both environments; dev/prod
separation happens at the *binding* layer (each Cloud Run service binds its own
secret to the same env name), not in code.

`R2_ENDPOINT` = `https://9f15f12d867a59b212ed2ae3cf4615ca.r2.cloudflarestorage.com`

## Secret Manager (hiyebo) → Cloud Run binding

Secrets follow the existing `YEBOTICKETS__*` convention (cf. `YEBOTICKETS__DATABASE_URL`).

| Cloud Run env       | `yebotickets-api-prod` secret           | `yebotickets-api-dev` secret                |
|---------------------|------------------------------------------|----------------------------------------------|
| `R2_ACCESS_KEY_ID`     | `YEBOTICKETS__R2_ACCESS_KEY_ID`         | `YEBOTICKETS__R2_ACCESS_KEY_ID_DEV`         |
| `R2_SECRET_ACCESS_KEY` | `YEBOTICKETS__R2_SECRET_ACCESS_KEY`     | `YEBOTICKETS__R2_SECRET_ACCESS_KEY_DEV`     |
| `R2_ENDPOINT`          | `YEBOTICKETS__R2_ENDPOINT`              | `YEBOTICKETS__R2_ENDPOINT` (shared)         |
| `R2_BUCKET_NAME`       | `YEBOTICKETS__R2_BUCKET_NAME`           | `YEBOTICKETS__R2_BUCKET_NAME_DEV`           |
| `R2_PUBLIC_URL`        | `YEBOTICKETS__R2_PUBLIC_URL`            | `YEBOTICKETS__R2_PUBLIC_URL_DEV`            |

The credential token is scoped to both buckets, so the `_DEV` credential
secrets hold the same value; they are kept separate for clean per-env rotation.

`DATABASE_URL` follows the same per-env split:

| Cloud Run env  | `yebotickets-api-prod` secret  | `yebotickets-api-dev` secret        |
|----------------|---------------------------------|--------------------------------------|
| `DATABASE_URL` | `YEBOTICKETS__DATABASE_URL`     | `YEBOTICKETS__DATABASE_URL_DEV`      |

(The dev DB URL was previously an inline plaintext env var on `yebotickets-api-dev`;
it is now stored in `YEBOTICKETS__DATABASE_URL_DEV` so the pipeline can bind it
as a secret just like prod.)

Runtime SA for both services: `yebotickets-runtime@hiyebo.iam.gserviceaccount.com`
(granted `roles/secretmanager.secretAccessor` on all ten secrets — the nine R2
secrets plus `YEBOTICKETS__DATABASE_URL_DEV`). Bound additively with
`gcloud run services update --update-secrets`.

## Deploy-pipeline (reconciled)

`api.yebotickets.com` maps to Cloud Run service **`yebotickets-api-prod`** and
`dev-api.yebotickets.com` to **`yebotickets-api-dev`**. This repo's
`cloudbuild.yaml` now deploys those domain-mapped services directly (it used to
deploy a *third*, orphan service named `yebotickets-api`). One file serves both
environments via substitutions:

- File-level defaults target **prod** (`_SERVICE=yebotickets-api-prod`, prod
  secret names).
- The `yebotickets-api-dev` Cloud Build trigger (branch `^dev$`) overrides
  `_SERVICE` and the `*_SECRET` substitutions to the `_DEV` variants. The
  `yebotickets-api-prod` trigger (branch `^main$`) pins the prod values
  explicitly for symmetry.
- `R2_ENDPOINT` is the account-level Cloudflare S3 endpoint shared by both
  buckets, so it has no `_DEV` variant — both envs read `YEBOTICKETS__R2_ENDPOINT`.

Secret bindings still use `--update-secrets` (additive, per CLAUDE.md) so a
deploy never wipes a binding applied out of band and preserves plain env vars
(e.g. `_MIGRATION_MARKER`). The build runs as `yebotickets-runtime@hiyebo`,
which holds project-level `roles/run.admin` + `roles/iam.serviceAccountUser`
(actAs on the runtime SA) — sufficient to deploy both services.
