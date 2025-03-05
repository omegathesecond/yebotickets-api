import { body } from 'express-validator';

export const createEventValidator = [
  body('title')
    .notEmpty()
    .withMessage('Event title is required')
    .isString()
    .withMessage('Title must be a string')
    .isLength({ min: 3, max: 100 })
    .withMessage('Title must be between 3 and 100 characters'),
  
  body('description')
    .notEmpty()
    .withMessage('Event description is required')
    .isString()
    .withMessage('Description must be a string'),
  
  body('location.address')
    .notEmpty()
    .withMessage('Event address is required')
    .isString()
    .withMessage('Address must be a string'),
  
  body('location.city')
    .notEmpty()
    .withMessage('City is required')
    .isString()
    .withMessage('City must be a string'),
  
  body('location.country')
    .notEmpty()
    .withMessage('Country is required')
    .isString()
    .withMessage('Country must be a string'),
  
  body('location.coordinates')
    .optional()
    .isObject()
    .withMessage('Coordinates must be an object'),
  
  body('location.coordinates.lat')
    .optional()
    .isNumeric()
    .withMessage('Latitude must be a number'),
  
  body('location.coordinates.lng')
    .optional()
    .isNumeric()
    .withMessage('Longitude must be a number'),
  
  body('startDate')
    .notEmpty()
    .withMessage('Start date is required')
    .isISO8601()
    .withMessage('Start date must be a valid date in ISO 8601 format'),
  
  body('endDate')
    .notEmpty()
    .withMessage('End date is required')
    .isISO8601()
    .withMessage('End date must be a valid date in ISO 8601 format')
    .custom((value, { req }) => {
      if (new Date(value) <= new Date(req.body.startDate)) {
        throw new Error('End date must be after start date');
      }
      return true;
    }),
  
  body('category')
    .notEmpty()
    .withMessage('Event category is required')
    .isString()
    .withMessage('Category must be a string'),
  
  body('coverImage')
    .optional()
    .isURL()
    .withMessage('Cover image must be a valid URL'),
  
  body('isPublished')
    .optional()
    .isBoolean()
    .withMessage('isPublished must be a boolean'),
];

export const updateEventValidator = [
  body('title')
    .optional()
    .isString()
    .withMessage('Title must be a string')
    .isLength({ min: 3, max: 100 })
    .withMessage('Title must be between 3 and 100 characters'),
  
  body('description')
    .optional()
    .isString()
    .withMessage('Description must be a string'),
  
  body('location')
    .optional()
    .isObject()
    .withMessage('Location must be an object'),
  
  body('location.address')
    .optional()
    .isString()
    .withMessage('Address must be a string'),
  
  body('location.city')
    .optional()
    .isString()
    .withMessage('City must be a string'),
  
  body('location.country')
    .optional()
    .isString()
    .withMessage('Country must be a string'),
  
  body('startDate')
    .optional()
    .isISO8601()
    .withMessage('Start date must be a valid date in ISO 8601 format'),
  
  body('endDate')
    .optional()
    .isISO8601()
    .withMessage('End date must be a valid date in ISO 8601 format')
    .custom((value, { req }) => {
      if (req.body.startDate && new Date(value) <= new Date(req.body.startDate)) {
        throw new Error('End date must be after start date');
      }
      return true;
    }),
  
  body('category')
    .optional()
    .isString()
    .withMessage('Category must be a string'),
  
  body('coverImage')
    .optional()
    .isURL()
    .withMessage('Cover image must be a valid URL'),
  
  body('isPublished')
    .optional()
    .isBoolean()
    .withMessage('isPublished must be a boolean'),
]; 