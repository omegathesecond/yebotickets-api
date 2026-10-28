# Durable buyer purchases

Apply migration `20261027171000_durable_purchase_attempt` before deploying the API. This task does not run migrations or deploy.

`POST /api/tickets/purchase/:ticketTypeId` requires `idempotencyKey` for paid and free orders (16–128 ASCII letters, digits, underscore or hyphen). The key is globally unique, owned by one buyer and bound to tier, quantity and payment intent. Reusing a key with different intent or a different principal returns 409. No compatibility path generates a server key.

The identity and inventory allocation commit together under a key-scoped PostgreSQL advisory transaction lock. Only the creating request dispatches the payment, after commit. Replays recover the original tickets; they never create a charge. Payment intent is hashed, not stored as raw credentials. The attempt's ticket IDs survive release or deletion; a released attempt cannot attach another allocation to the original charge.

`POST /api/tickets/purchase-attempts/:key/recover` requires buyer authentication. It returns issued tickets, a pending/unknown hold (202), or a terminal failure (`failed: true`). Gateway lookup failures propagate through the normal API error channel. If no attempt exists, recovery closes the key under the same lock, fencing a delayed original purchase request. This endpoint can settle an existing charge and dispatch its existing delivery work; it cannot initiate payment.

A gateway timeout leaves PROCESSING seats held with the immutable attempt reference in the charge description. The signed webhook binds that reference to its charge and uses the existing settlement and delivery helpers. A crash between charge binding and ticket-reference attachment is repaired during recovery. An unknown call is never redispatched or expired blindly. If neither the gateway response nor a signed webhook arrives, the hold requires operational reconciliation; recovery says the outcome is unconfirmed and blocks another charge in the buyer flow.

The buyer stores only key, buyer ID and event ID locally, before dispatch. Browser Web Locks serialize key creation across tabs. Reload restores recovery, including for sold-out/closed tiers. A new explicit purchase is offered only after the prior authoritative final outcome has been displayed. Delivery replays use the existing durable delivery work item and compare-and-set dispatcher.
