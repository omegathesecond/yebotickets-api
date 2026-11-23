import { ApiError } from "../middleware/error.middleware";

/** Source account state, checked against the database rather than token roles. */
export function assertAccountActive(user: { isActive: boolean }) {
  if (!user.isActive)
    throw new ApiError("Account access is suspended. Contact support.", 403);
}

export function assertCurrentSession(
  user: { isActive: boolean; authVersion: number },
  payload: { authVersion: number },
) {
  assertAccountActive(user);
  if (user.authVersion !== payload.authVersion)
    throw new ApiError("This session has been revoked. Sign in again.", 401);
}
