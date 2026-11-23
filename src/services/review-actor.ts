import { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";

export type ReviewActor =
  | { productAdminId: string; corporateStaffId?: never }
  | { corporateStaffId: string; productAdminId?: never };

/** Product identities and verified corporate staff occupy separate audit fields. */
export const reviewActor = (actor: ReviewActor) => {
  if (!actor || typeof actor !== "object")
    throw new ApiError("A verified review actor is required", 401);
  if ("corporateStaffId" in actor) {
    if (
      typeof actor.corporateStaffId !== "string" ||
      !actor.corporateStaffId ||
      actor.corporateStaffId !== staffAdminScope.actor()?.id ||
      actor.productAdminId !== undefined
    )
      throw new ApiError(
        "Corporate reviewer does not match this verified request",
        403,
      );
    return { adminId: null, staffId: actor.corporateStaffId };
  }
  if (typeof actor.productAdminId !== "string" || !actor.productAdminId)
    throw new ApiError("A product reviewer is required", 401);
  return { adminId: actor.productAdminId, staffId: null };
};
