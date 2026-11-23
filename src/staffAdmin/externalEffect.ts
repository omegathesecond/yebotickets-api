import type { Prisma } from "@prisma/client";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { review } from "./reviewTarget";
import { recordStaffOperation, StaffOperationContext } from "./audit";
import { staffOperationStore } from "./receipts";

/** Shared initial audit/target lock for source-owned external effects. */
export async function prepareReviewedEffect<T>(
  context: StaffOperationContext,
  expectedOperation: string,
  detail: Record<string, unknown> | (() => Promise<Record<string, unknown>>),
  run: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await staffAdminScope.transaction(async () => {
      const target = await review(context.name, context.parameters, true);
      const receipt = await staffOperationStore.get(context.id);
      if (
        context.name !== expectedOperation ||
        staffAdminScope.actor()?.id !== context.actor.id ||
        !receipt ||
        receipt.actorId !== context.actor.id ||
        receipt.targetKey !== context.targetKey ||
        !["running", "unknown"].includes(receipt.state ?? "")
      )
        throw new ApiError(
          "The reviewed corporate operation is not active",
          409,
        );
      if (target.version !== context.reviewedVersion)
        throw new ApiError(
          "Target changed since review; prepare a fresh request",
          409,
        );
      await recordStaffOperation(
        context,
        prisma,
        typeof detail === "function" ? await detail() : detail,
      );
      return run(prisma);
    });
  } catch (error: any) {
    if (error.corporateRollbackConfirmed === true)
      await staffOperationStore.finish(
        context.id,
        "failed",
        error.statusCode ?? 500,
        {
          success: false,
          error: error.message,
          operation: { id: context.id, state: "failed" },
        },
      );
    throw error;
  }
}
