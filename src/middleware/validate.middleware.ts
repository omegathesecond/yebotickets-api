import { Request, Response, NextFunction } from "express";
import { validationResult, ValidationChain } from "express-validator";
import { ApiError } from "./error.middleware";

export const assertValidRequest = async (
  validations: ValidationChain[],
  req: Request,
) => {
  // Run all validations
  await Promise.all(validations.map((validation) => validation.run(req)));

  // Check if there are validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = [
      ...new Set(errors.array().map((error) => String(error.msg))),
    ];
    throw new ApiError("Validation failed: " + messages.join("; "), 400);
  }
};

export const validate = (validations: ValidationChain[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await assertValidRequest(validations, req);
      next();
    } catch (error) {
      next(error);
    }
  };
};
