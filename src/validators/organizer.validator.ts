import { body, oneOf, ValidationChain } from 'express-validator';

export const changePasswordValidator: ValidationChain[] = [
  body('currentPassword')
    .isString()
    .withMessage('Current password must be a string')
    .notEmpty()
    .withMessage('Current password is required'),

  body('newPassword')
    .isString()
    .withMessage('New password must be a string')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('New password must contain at least one uppercase letter, one lowercase letter, and one number'),
];

export const organizerSignupValidator = [
  body('name')
    .isString()
    .withMessage('Name must be a string')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
  
  body('phoneNumber')
    .isString()
    .withMessage('Phone number must be a string')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Please provide a valid phone number'),
  
  body('password')
    .isString()
    .withMessage('Password must be a string')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  
  body('email')
    .optional()
    .isEmail()
    .withMessage('Please provide a valid email address'),
  
  body('organizerProfile')
    .optional()
    .isObject()
    .withMessage('Organizer profile must be an object'),
  
  body('organizerProfile.companyName')
    .optional()
    .isString()
    .withMessage('Company name must be a string')
    .isLength({ min: 2, max: 100 })
    .withMessage('Company name must be between 2 and 100 characters'),
  
  body('organizerProfile.description')
    .optional()
    .isString()
    .withMessage('Description must be a string')
    .isLength({ min: 10, max: 1000 })
    .withMessage('Description must be between 10 and 1000 characters'),
];

export const organizerLoginValidator: ValidationChain[] = [
  body().custom((value, { req }) => {
    if (!req.body.phoneNumber && !req.body.email) {
      throw new Error('Either phone number or email is required');
    }
    return true;
  }),
  
  body('phoneNumber')
    .optional()
    .isString()
    .withMessage('Phone number must be a string')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Please provide a valid phone number'),
  
  body('email')
    .optional()
    .isEmail()
    .withMessage('Please provide a valid email address'),
  
  body('password')
    .isString()
    .withMessage('Password must be a string')
    .notEmpty()
    .withMessage('Password is required'),
];

// isVerified records phone verification; the owning model has no isActive field.
// Reject unsupported flags instead of silently claiming to suspend an account.
export const organizerStatusValidator: ValidationChain[] = [
  body().custom(value => {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => key !== 'isVerified')) throw new Error('Only the phone verification flag is supported by this endpoint');
    return true;
  }),
  body('isVerified').isBoolean().withMessage('Choose a phone verification flag'),
];
