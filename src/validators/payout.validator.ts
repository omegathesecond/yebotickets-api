import { body } from 'express-validator';

export const payoutMethodValidator = [
  body('payoutMethod')
    .optional()
    .isIn(['bank_transfer', 'mobile_money'])
    .withMessage('payoutMethod must be bank_transfer or mobile_money'),

  body('payoutBankName').optional().isString().withMessage('Bank name must be a string'),
  body('payoutBankAccountName').optional().isString().withMessage('Bank account name must be a string'),
  body('payoutBankAccountNumber').optional().isString().withMessage('Bank account number must be a string'),
  body('payoutBankBranch').optional().isString().withMessage('Bank branch must be a string'),
  body('payoutMobileProvider').optional().isString().withMessage('Mobile money provider must be a string'),
  body('payoutMobileNumber').optional().isString().withMessage('Mobile money number must be a string'),
];

export const createPayoutRequestValidator = [
  body('amount')
    .isFloat({ gt: 0 })
    .withMessage('amount must be a positive number'),
];

export const payoutRequestStatusValidator = [
  body('status')
    .isIn(['paid', 'rejected'])
    .withMessage('status must be paid or rejected'),

  body('adminNote').optional().isString().withMessage('adminNote must be a string'),
];
