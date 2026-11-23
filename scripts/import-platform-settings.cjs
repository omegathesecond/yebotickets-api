"use strict";
const { execFileSync } = require("node:child_process");
const { PrismaClient, Prisma } = require("@prisma/client");
const {
  runtimeTarget,
  reviewedRuntimeBaseline,
  importSettings,
  validateImportConnections,
} = require("./lib/platform-settings-import.cjs");

async function main() {
  const args = process.argv.slice(2),
    values = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") {
      if (values.apply) throw new Error("Duplicate --apply");
      values.apply = true;
      continue;
    }
    if (
      ![
        "--environment",
        "--expected-revision",
        "--expected-fee-percent",
      ].includes(args[i]) ||
      values[args[i]] !== undefined ||
      args[i + 1] === undefined
    )
      throw new Error(
        "Use --environment prod|dev --expected-revision <reviewed-revision> --expected-fee-percent <reviewed-rate> [--apply]",
      );
    values[args[i]] = args[++i];
  }
  const environment = values["--environment"],
    target = runtimeTarget(environment);
  const rawFee = values["--expected-fee-percent"];
  if (!target || typeof rawFee !== "string" || !rawFee.trim())
    throw new Error(
      "An explicit environment, reviewed revision and commission are required",
    );
  const read = (args) => {
    try {
      return execFileSync("gcloud", ["--configuration=deployer", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error(
        "Could not read the requested GCP resource with the deployer configuration",
      );
    }
  };
  const describe = () =>
    JSON.parse(
      read([
        "run",
        "services",
        "describe",
        target.service,
        "--region=europe-west1",
        "--project=hiyebo",
        "--format=json",
      ]),
    );
  const baseline = reviewedRuntimeBaseline(
    describe(),
    environment,
    values["--expected-revision"],
    Number(rawFee),
  );
  if (!values.apply) {
    console.log(
      JSON.stringify({
        mode: "read-only",
        environment,
        service: target.service,
        ...baseline,
        next: "After migration and explicit release approval, repeat the reviewed command with --apply before serving the new API.",
      }),
    );
    return;
  }
  const secret = (name) =>
    read([
      "secrets",
      "versions",
      "access",
      "latest",
      "--secret=" + name,
      "--project=hiyebo",
    ]).trim();
  const direct = secret(target.direct),
    pooled = secret(target.database);
  validateImportConnections(direct, pooled);
  // Revalidate immediately before the local transaction. Hold deployment/config
  // changes during the reviewed import; no distributed GCP/SQL lock is claimed.
  reviewedRuntimeBaseline(
    describe(),
    environment,
    values["--expected-revision"],
    Number(rawFee),
  );
  const client = new PrismaClient({
    datasources: { db: { url: direct } },
    log: [],
  });
  try {
    const result = await importSettings(client, baseline);
    console.log(
      JSON.stringify({
        mode: "imported",
        environment,
        id: result.id,
        feePercent: result.feePercent,
        revision: result.revision,
        initializedFromRevision: result.initializedFromRevision,
      }),
    );
  } finally {
    await client.$disconnect();
  }
}
main().catch((error) => {
  // Never log a connection string or subprocess output containing a credential.
  const message =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? `Database rejected the settings import (${error.code}); check the migration and existing import receipt.`
      : error instanceof Prisma.PrismaClientInitializationError
        ? "Could not connect to the selected direct database."
        : error.message;
  console.error("Settings import failed: " + message);
  process.exitCode = 1;
});
