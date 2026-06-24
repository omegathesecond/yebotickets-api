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

Runtime SA for both services: `yebotickets-runtime@hiyebo.iam.gserviceaccount.com`
(granted `roles/secretmanager.secretAccessor` on all nine secrets). Bound
additively with `gcloud run services update --update-secrets`, preserving
`DATABASE_URL`.

## ⚠ Deploy-pipeline caveat (pre-existing, not introduced here)

`api.yebotickets.com` maps to Cloud Run service **`yebotickets-api-prod`** and
`dev-api.yebotickets.com` to **`yebotickets-api-dev`**. But the Cloud Build
triggers (`yebotickets-api-prod` on `main`, `yebotickets-api-dev` on `dev`) both
run this repo's `cloudbuild.yaml`, which deploys a *third* service named
**`yebotickets-api`** (default compute SA, no custom domain). So pushes do not
currently redeploy the domain-mapped services — `yebotickets-api-prod` is frozen
at its manually-created revision. Until that mismatch is fixed (point the deploy
step at `yebotickets-api-prod` / `-dev`, ideally per-env), the R2 env above was
bound directly to the live services out of band, which is why `cloudbuild.yaml`
now uses `--update-secrets` (additive) rather than `--set-secrets` (destructive).
