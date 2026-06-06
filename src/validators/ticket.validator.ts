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
  // Ticket type ids are Prisma `uuid()` values (see prisma/schema.prisma), NOT
  // Mongo ObjectIds. Validating with isMongoId() rejected every real id with a
  // 400 and blocked the public buyer purchase flow end-to-end. Same fix the
  // check-in lookup validator already applies for its UUID params.
  param('ticketTypeId')
    .notEmpty()
    .withMessage('Ticket type ID is required')
    .isUUID()
    .withMessage('Invalid ticket type ID format'),

  // Payment details (forwarded to YeboPay). All optional at this layer because
  // free (price 0) tickets carry no payment; the service enforces that a PRICED
  // ticket must arrive with a usable instrument. Here we only type-check shape.
  body('paymentMethodId')
    .optional()
    .isString()
    .withMessage('paymentMethodId must be a string'),

  body('providerCode')
    .optional()
    .isString()
    .withMessage('providerCode must be a string'),

  body('country')
    .optional()
    .isISO31661Alpha2()
    .withMessage('country must be a 2-letter ISO code'),

  body('phone')
    .optional()
    .isString()
    .withMessage('phone must be a string'),

  body('cardToken')
    .optional()
    .isString()
    .withMessage('cardToken must be a string'),

  body('idempotencyKey')
    .optional()
    .isString()
    .withMessage('idempotencyKey must be a string'),

  // Mobile-money rails need a phone; if a one-off providerCode is given without
  // a saved paymentMethodId and without a card token, require the phone so we
  // fail fast with a clear 400 instead of a downstream YeboPay error.
  body('phone')
    .if(body('providerCode').exists({ checkFalsy: true }))
    .if(body('paymentMethodId').not().exists({ checkFalsy: true }))
    .if(body('cardToken').not().exists({ checkFalsy: true }))
    .notEmpty()
    .withMessage('phone is required for this payment method'),
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