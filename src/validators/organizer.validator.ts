import { body, oneOf, ValidationChain } from 'express-validator';

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

export const organizerProfileValidator = [
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
  
  // Organizer-specific fields
  body('companyName')
    .optional()
    .isString()
    .withMessage('Company name must be a string')
    .isLength({ min: 2, max: 100 })
    .withMessage('Company name must be between 2 and 100 characters'),
  
  body('description')
    .optional()
    .isString()
    .withMessage('Description must be a string')
    .isLength({ min: 10, max: 1000 })
    .withMessage('Description must be between 10 and 1000 characters'),
  
  body('website')
    .optional()
    .isURL()
    .withMessage('Please provide a valid website URL'),
  
  body('socialMedia')
    .optional()
    .isObject()
    .withMessage('Social media must be an object'),
  
  body('socialMedia.facebook')
    .optional()
    .isURL()
    .withMessage('Please provide a valid Facebook URL'),
  
  body('socialMedia.twitter')
    .optional()
    .isURL()
    .withMessage('Please provide a valid Twitter URL'),
  
  body('socialMedia.instagram')
    .optional()
    .isURL()
    .withMessage('Please provide a valid Instagram URL'),
  
  body('address')
    .optional()
    .isObject()
    .withMessage('Address must be an object'),
  
  body('address.street')
    .optional()
    .isString()
    .withMessage('Street must be a string'),
  
  body('address.city')
    .optional()
    .isString()
    .withMessage('City must be a string'),
  
  body('address.state')
    .optional()
    .isString()
    .withMessage('State must be a string'),
  
  body('address.zipCode')
    .optional()
    .isString()
    .withMessage('Zip code must be a string'),
  
  body('address.country')
    .optional()
    .isString()
    .withMessage('Country must be a string'),
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

export const organizerStatusValidator: ValidationChain[] = [
  body('isVerified')
    .optional()
    .isBoolean()
    .withMessage('isVerified must be a boolean'),
  
  body('isActive')
    .optional()
    .isBoolean()
    .withMessage('isActive must be a boolean'),
]; 