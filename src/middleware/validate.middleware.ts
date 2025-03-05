import { Request, Response, NextFunction } from 'express';
import { validationResult, ValidationChain } from 'express-validator';
import { ApiError } from './error.middleware';

export const validate = (validations: ValidationChain[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Run all validations
    await Promise.all(validations.map(validation => validation.run(req)));

    // Check if there are validation errors
    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }

    const extractedErrors: { [key: string]: string } = {};
    errors.array().forEach(err => {
      if (err.type === 'field' && err.path) {
        extractedErrors[err.path] = err.msg;
      }
    });

    // If validation errors exist, return a 400 response with the errors
    return next(new ApiError('Validation failed', 400));
  };
}; 