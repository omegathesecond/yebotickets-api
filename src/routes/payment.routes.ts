import express from 'express';
import { yebopayWebhookController } from '../controllers/payment.controller';

const router = express.Router();

/**
 * @swagger
 * /api/payments/webhook:
 *   post:
 *     summary: YeboPay charge settlement webhook
 *     tags: [Payments]
 *     description: >
 *       Receives signed YeboPay charge events. On charge.succeeded the matching
 *       reserved ticket is finalized to sold and its QR delivered; on
 *       charge.failed the reservation is released. Verified via the
 *       YeboPay-Signature HMAC header — unverified deliveries are rejected 401.
 *       Idempotent (redelivery is a no-op).
 *     responses:
 *       200: { description: Verified and handled }
 *       401: { description: Signature missing/invalid — rejected }
 *       500: { description: Verified but handling failed }
 */
// express.raw() captures the exact signed bytes for HMAC verification. This
// route is also mounted in server.ts BEFORE the global express.json(), so the
// JSON parser never consumes the body first.
router.post('/webhook', express.raw({ type: '*/*' }), yebopayWebhookController);

export default router;
