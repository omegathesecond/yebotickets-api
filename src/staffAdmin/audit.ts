import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { redact } from "@omevision/product-admin-boundary";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { targetKey } from "./reviewTarget";

export interface StaffOperationContext {
  id: string;
  actor: { id: string; name?: string; email?: string; role?: string };
  name: string;
  targetKey: string;
  parameters: Record<string, any>;
  reviewedVersion: string;
}
export function verifiedStaffOperation(req: Request): StaffOperationContext {
  const actor = staffAdminScope.actor(),
    id = req.get("Idempotency-Key"),
    native = req.res?.locals.native;
  if (
    !actor ||
    !id ||
    !native ||
    typeof req.res?.locals.nativeTargetVersion !== "string"
  )
    throw new ApiError("A verified corporate operation is required", 401);
  return {
    id,
    actor,
    name: native.name,
    targetKey: targetKey(native.name, native.parameters),
    parameters: native.parameters,
    reviewedVersion: req.res!.locals.nativeTargetVersion,
  };
}
export async function recordStaffOperation(
  context: StaffOperationContext,
  client: Prisma.TransactionClient = prisma,
  detail?: Record<string, unknown>,
) {
  await client.$executeRawUnsafe(
    'INSERT INTO staff_admin_audit(id,"staffId","staffName","staffEmail",operation,"targetKey",parameters) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)',
    context.id,
    context.actor.id,
    context.actor.name ?? null,
    context.actor.email ?? null,
    context.name,
    context.targetKey,
    JSON.stringify(
      redact({
        ...context.parameters,
        ...(detail ? { reviewedEffect: detail } : {}),
      }),
    ),
  );
}
