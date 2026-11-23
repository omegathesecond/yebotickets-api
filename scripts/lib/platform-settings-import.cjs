"use strict";
const {
  PLATFORM_SETTINGS_ID,
  assertPlatformFeePercent,
} = require("../../dist/config/platform");

const {
  lockTransactionIdentity,
} = require("../../dist/utils/transactionIdentity");
const targets = {
  prod: {
    service: "yebotickets-api-prod",
    database: "YEBOTICKETS__DATABASE_URL",
    direct: "YEBOTICKETS__DIRECT_URL",
  },
  dev: {
    service: "yebotickets-api-dev",
    database: "YEBOTICKETS__DATABASE_URL_DEV",
    direct: "YEBOTICKETS__DIRECT_URL_DEV",
  },
};

/** Import evidence from the actual old runtime, never a new runtime fallback. */
function runtimeTarget(environment) {
  if (!Object.hasOwn(targets, environment))
    throw new Error("Choose prod or dev explicitly");
  return targets[environment];
}
function reviewedRuntimeBaseline(
  resource,
  environment,
  expectedRevision,
  expectedFee,
) {
  const target = runtimeTarget(environment);
  assertPlatformFeePercent(expectedFee);
  if (resource.metadata?.name !== target.service)
    throw new Error("Runtime service does not match the selected environment");
  const status = resource.status;
  if (
    !expectedRevision ||
    status?.latestReadyRevisionName !== expectedRevision ||
    status.latestCreatedRevisionName !== expectedRevision
  )
    throw new Error(
      "Runtime revision changed or is not fully ready; review the current deployment",
    );
  const traffic = status.traffic?.filter((t) => t.percent > 0);
  if (
    traffic?.length !== 1 ||
    traffic[0].percent !== 100 ||
    traffic[0].revisionName !== expectedRevision
  )
    throw new Error(
      "A single reviewed revision must serve all traffic during the settings import",
    );
  const spec = resource.spec?.template?.spec;
  if (spec?.containers?.length !== 1)
    throw new Error("Review the actual runtime container configuration");
  const env = spec.containers[0].env ?? [];
  const database = env.find((e) => e.name === "DATABASE_URL");
  if (database?.valueFrom?.secretKeyRef?.name !== target.database)
    throw new Error(
      "Runtime database binding does not match the selected environment",
    );
  const configured = env.filter((e) => e.name === "PLATFORM_FEE_PERCENT");
  if (configured.length > 1 || configured.some((e) => e.valueFrom))
    throw new Error(
      "Review the actual source commission configuration before importing",
    );
  // The old owning service explicitly defined an unset/blank rate as0. This
  // one-time data conversion is not used by the new runtime or settings reader.
  const raw = configured[0]?.value;
  const actualFee = raw === undefined || raw.trim() === "" ? 0 : Number(raw);
  assertPlatformFeePercent(actualFee);
  if (actualFee !== expectedFee)
    throw new Error(
      "Deployed commission differs from the reviewed import amount",
    );
  return {
    id: PLATFORM_SETTINGS_ID,
    feePercent: actualFee,
    initializedFromRevision: expectedRevision,
  };
}

/** Stable bootstrap replay cannot overwrite a subsequent CEO decision. */
async function importSettings(client, baseline) {
  if (baseline.id !== PLATFORM_SETTINGS_ID || !baseline.initializedFromRevision)
    throw new Error("A reviewed source baseline is required");
  assertPlatformFeePercent(baseline.feePercent);
  return client.$transaction(async (tx) => {
    await lockTransactionIdentity(tx, "yebotickets:platform-settings-import");
    const prior = await tx.platformSettings.findUnique({
      where: { id: PLATFORM_SETTINGS_ID },
    });
    if (prior) {
      if (
        prior.feePercent === baseline.feePercent &&
        prior.initializedFromRevision === baseline.initializedFromRevision &&
        prior.revision === 0 &&
        prior.updatedByStaff === null
      )
        return prior;
      throw new Error(
        "Settings already exist or were changed; this import cannot overwrite them",
      );
    }
    return tx.platformSettings.create({ data: baseline });
  });
}
module.exports = { runtimeTarget, reviewedRuntimeBaseline, importSettings };
