import { Request, Response } from 'express';
import { processWebhook, WebhookVerificationError } from '../services/payment-webhook.service';

/**
 * POST /api/payments/webhook — receive YeboPay charge settlement webhooks.
 *
 * The route mounts express.raw() so `req.body` here is a Buffer of the exact
 * bytes YeboPay signed; we verify the HMAC against it before acting. Responses:
 *   - 200  verified + handled (including idempotent no-ops / ignored event
 *          types) — tells YeboPay the delivery succeeded so it isn't re-queued.
 *   - 401  signature missing/malformed/mismatched — we refuse to trust it.
 *   - 500  verified but handling threw — surfaced loudly (no silent swallow);
 *          the reclaim poll reconciles anything dropped here.
 *
 * Note: we do NOT use the shared error middleware for the 401 path so an
 * attacker probing the endpoint gets a flat rejection, and a verification
 * failure can never be mistaken for a handled event.
 */
export const yebopayWebhookController = async (req: Request, res: Response): Promise<void> => {
  const signature = req.header('YeboPay-Signature') ?? req.header('yebopay-signature');
  // express.raw() yields a Buffer; guard in case the parser didn't run.
  const rawBody = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');

  try {
    const { event, outcome } = await processWebhook(rawBody, signature);
    console.log('YeboPay webhook handled', {
      eventId: event.id,
      type: event.type,
      chargeId: event.data.id,
      outcome: outcome.result,
    });
    res.status(200).json({ received: true, outcome: outcome.result });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      console.error('Rejected YeboPay webhook:', error.message);
      res.status(401).json({ received: false, error: error.message });
      return;
    }
    // Verified but processing failed — surface it (500) rather than fake a 200.
    console.error('Error handling YeboPay webhook:', error);
    res.status(500).json({ received: false, error: 'Webhook handling failed' });
  }
};
