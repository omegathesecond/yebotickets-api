import { body, param } from 'express-validator';
import { TicketType as TicketTypeEnum } from '../interfaces/ticket.interface';

export const createTicketTypeValidator = [
  body('name')
    .notEmpty()
    .withMessage('Ticket type name is required')
    .isString()
    .withMessage('Name must be a string')
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  
  body('description')
    .optional()
    .isString()
    .withMessage('Description must be a string'),
  
  body('price')
    .notEmpty()
    .withMessage('Price is required')
    .isNumeric()
    .withMessage('Price must be a number')
    .custom((value) => {
      if (parseFloat(value) < 0) {
        throw new Error('Price cannot be negative');
      }
      return true;
    }),
  
  body('quantity')
    .notEmpty()
    .withMessage('Quantity is required')
    .isInt({ min: 1 })
    .withMessage('Quantity must be a positive integer'),
  
  body('type')
    .optional()
    .isIn(Object.values(TicketTypeEnum))
    .withMessage('Invalid ticket type'),
  
  body('saleStartDate')
    .notEmpty()
    .withMessage('Sale start date is required')
    .isISO8601()
    .withMessage('Sale start date must be a valid date in ISO 8601 format'),
  
  body('saleEndDate')
    .notEmpty()
    .withMessage('Sale end date is required')
    .isISO8601()
    .withMessage('Sale end date must be a valid date in ISO 8601 format')
    .custom((value, { req }) => {
      if (new Date(value) <= new Date(req.body.saleStartDate)) {
        throw new Error('Sale end date must be after sale start date');
      }
      return true;
    }),
];

export const updateTicketTypeValidator = [
  body('name')
    .optional()
    .isString()
    .withMessage('Name must be a string')
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  
  body('description')
    .optional()
    .isString()
    .withMessage('Description must be a string'),
  
  body('price')
    .optional()
    .isNumeric()
    .withMessage('Price must be a number')
    .custom((value) => {
      if (parseFloat(value) < 0) {
        throw new Error('Price cannot be negative');
      }
      return true;
    }),
  
  body('quantity')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Quantity must be a positive integer'),
  
  body('type')
    .optional()
    .isIn(Object.values(TicketTypeEnum))
    .withMessage('Invalid ticket type'),
  
  body('saleStartDate')
    .optional()
    .isISO8601()
    .withMessage('Sale start date must be a valid date in ISO 8601 format'),
  
  body('saleEndDate')
    .optional()
    .isISO8601()
    .withMessage('Sale end date must be a valid date in ISO 8601 format')
    .custom((value, { req }) => {
      if (req.body.saleStartDate && new Date(value) <= new Date(req.body.saleStartDate)) {
        throw new Error('Sale end date must be after sale start date');
      }
      return true;
    }),
];

export const generateTicketsValidator = [
  body('quantity')
    .notEmpty()
    .withMessage('Quantity is required')
    .isInt({ min: 1, max: 1000 })
    .withMessage('Quantity must be between 1 and 1000'),
];

export const purchaseTicketValidator = [
  param('ticketTypeId')
    .notEmpty()
    .withMessage('Ticket type ID is required')
    .isMongoId()
    .withMessage('Invalid ticket type ID format'),
];

export const verifyTicketValidator = [
  body('ticketCode')
    .notEmpty()
    .withMessage('Ticket code is required')
    .isString()
    .withMessage('Ticket code must be a string'),

  body('eventId')
    .notEmpty()
    .withMessage('Event ID is required')
    .isString()
    .withMessage('Event ID must be a string'),
];

// Used by the two-step gate check-in (/check-in-details and /confirm-check-in).
// The scanner QR carries { eventId, ticketId } where ticketId is the ticket's
// id (a UUID). Validate as plain strings — these are UUIDs, not Mongo ids.
export const checkInLookupValidator = [
  body('ticketId')
    .notEmpty()
    .withMessage('Ticket ID is required')
    .isString()
    .withMessage('Ticket ID must be a string'),

  body('eventId')
    .notEmpty()
    .withMessage('Event ID is required')
    .isString()
    .withMessage('Event ID must be a string'),
]; 