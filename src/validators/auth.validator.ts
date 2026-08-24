import { body } from 'express-validator';

export const requestOTPValidator = [
  body('phoneNumber')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Please provide a valid phone number'),
];

export const verifyOTPValidator = [
  body('phoneNumber')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Please provide a valid phone number'),
  
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must contain only numbers'),
];

export const refreshTokenValidator = [
  body('refreshToken')
    .notEmpty()
    .withMessage('Refresh token is required')
    .isString()
    .withMessage('Refresh token must be a string'),
];

export const requestPasswordResetValidator = [
  body().custom((value, { req }) => {
    if (!req.body.email && !req.body.phoneNumber) {
      throw new Error('Either email or phone number is required');
    }
    return true;
  }),

  body('email')
    .optional()
    .isEmail()
    .withMessage('Please provide a valid email address'),

  body('phoneNumber')
    .optional()
    .isString()
    .withMessage('Phone number must be a string')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Please provide a valid phone number'),
];

export const resetPasswordValidator = [
  body().custom((value, { req }) => {
    if (!req.body.email && !req.body.phoneNumber) {
      throw new Error('Either email or phone number is required');
    }
    return true;
  }),

  body('email')
    .optional()
    .isEmail()
    .withMessage('Please provide a valid email address'),

  body('phoneNumber')
    .optional()
    .isString()
    .withMessage('Phone number must be a string')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Please provide a valid phone number'),

  body('resetCode')
    .notEmpty()
    .withMessage('Reset code is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('Reset code must be 6 digits')
    .isNumeric()
    .withMessage('Reset code must contain only numbers'),

  body('newPassword')
    .isString()
    .withMessage('New password must be a string')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('New password must contain at least one uppercase letter, one lowercase letter, and one number'),
];

export const updateProfileValidator = [
  body('name')
    .optional()
    .isString()
    .withMessage('Name must be a string')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
  
  body('email')
    .optional()
    .isEmail()
    .withMessage('Please provide a valid email address'),
]; 