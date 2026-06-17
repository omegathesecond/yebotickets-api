# YeboTickets — Gap Scan (2026-06-17, re-verified against `main`)

Full-fleet audit of all five component repos (api, app, customer-dashboard, admin-dashboard, scanner-app) against the Omevision platform standards (YeboID auth, YeboPay payments, YeboLink comms, **no silent fallbacks**) and for missing/incomplete features.

> **⚠️ CORRECTION (re-run against current `main`).** The first pass of this scan was computed against a **stale checkout** — the api repo's working tree was parked on an abandoned pre-payment WIP branch, so the cited line numbers and the headline "tickets are free" finding described code that no longer exists on `main`. This document has been re-verified line-by-line against `origin/main` of every component repo. Two cards are **WITHDRAWN as false** (the headline payment card and the scanner silent-accept card), one card is **RESOLVED** (it was fixed by intervening work), one is **narrowed**, and the rest have **corrected line numbers**. See the "Withdrawn / corrected" section at the bottom.

**Revised headline: YeboTickets is healthier than the first pass claimed.** The payment path is wired (YeboPay reserve→charge→finalize), the public buyer **app** and **admin-dashboard** are production-shaped, and the customer-dashboard's previously type-broken event flow has since been fixed. The remaining real gaps are a draft-event leak, a YeboLink comms-standard deviation, fabricated organizer/scanner stats, a still-missing organizer landing-page stats endpoint, currency inconsistency, and a couple of dead CTAs.

8 gap-scan backlog cards remain valid (2 withdrawn, 1 resolved, of the original 10). This document is the durable record; cross-references are by `repo file:line` and were re-confirmed on `origin/main`.

---

## HIGH

### 2. `GET /events?showUnpublished=true` leaks unpublished/draft events to the public
- `api src/routes/event.routes.ts:103` — `router.get('/', getEventsController)` has **no `protect`/`authorize`**; `getEventsController` passes `req.query` through and `event.service.ts:94` honors `showUnpublished === 'true'` for anyone (`if (query.showUnpublished !== 'true') where.isPublished = true`). The admin dashboard depends on this exact call (`admin-dashboard admin-events.js:85`), so it can't simply be removed.
- **Fix:** ignore the flag unless the caller is an authenticated admin (`req.user?.role === 'admin'`). Card: `task-1781667777873-lpfuek` — **STILL VALID** (line shifted 74→103).

### 4. Comms bypass YeboLink — direct Meta WhatsApp Cloud API
- `api src/services/whatsapp.service.ts:11-12` posts to `graph.facebook.com` with `WHATSAPP_API_TOKEN`; OTP and ticket delivery both go through it. `.env.example` documents no YeboLink key. Violates the all-comms-through-YeboLink standard.
- **Fix:** YeboLink client bound via `YEBOTICKETS__YEBOLINK_API_KEY[_DEV]` (`/yebolink-implementation`). Card: `task-1781667779271-bydl5v` — **STILL VALID**.

### 5. Organizer dashboard landing page always 404s + fake notifications
- `customer-dashboard src/pages/dashboard/Dashboard.tsx:74-75` fetches `GET /user/dashboard-stats` and `/user/monthly-stats` — **neither exists** on the API (`api src/routes/user.routes.ts:34` has only `/user/events`). The default organizer landing page (KPIs + sales chart) renders the red error state for every organizer.
- `Dashboard.tsx:47` "Recent Notifications" is a hardcoded fake array presented as live activity (no-silent-fallback violation).
- **Fix:** add organizer-scoped `dashboard-stats`/`monthly-stats` endpoints; back or remove notifications. Card: `task-1781667797539-2iimhf` — **STILL VALID** (an in-flight task branch of the same id is implementing this; not yet on `main`).

---

## MEDIUM

### 7. Fabricated stats shown as real (no-silent-fallback violations)
- `api src/controllers/organizer.controller.ts:204-213` — `totalSold`/`totalRevenue` are always returned as `0` (the loop only increments `totalTypes`); organizers see zero sales regardless of reality.
- `scanner-app lib/screens/profile_screen.dart:61-63` — hardcoded `15` events / `1,560` sold / `$31,200` revenue.
- **Fix:** compute real counts/sums; remove scanner literals. Card: `task-1781667798919-pbcuvk` — **STILL VALID** (line/path corrected).

### 8. Organizer self-service menu links point at non-existent routes (NARROWED)
- `customer-dashboard src/lib/menu-list.ts:60,73,84` link to `/events/new`, `/scanner`, `/insights` — routes that don't exist, so the sidebar items dead-end.
- **NOTE — partially resolved since first pass:** the Profile page now wires real handlers (`profile/Profile.tsx:58 handleSaveChanges`, `:210 handleUpdatePassword`) — the earlier "Save/Update-Password are no-ops" claim is **stale**. Remaining work is the dead menu hrefs (and auditing Settings/Support for inert CTAs / leftover eneza copy).
- **Fix:** align menu hrefs to real routes (or hide); confirm Settings/Support do something or hide them. Card: `task-1781667814243-afudqe` — **NARROWED**.

### 9. Wrong/inconsistent currency — market is Eswatini (SZL/E)
- `api src/services/dashboard.service.ts:76` hardcodes `currency: 'KES'` (moved here from the old `dashboard.routes.ts:127`). The rest of the api now uses `SZL`/`TICKET_CURRENCY`/`CURRENCY` (`ticket.service.ts:966`, `organizer-event.service.ts:53`), so this lone `KES` literal is the inconsistency. `app src/components/EventCard.tsx` defaults `ZAR`/`en-ZA`; `scanner-app profile_screen.dart` shows `$`.
- **Fix:** standardize on SZL/E everywhere; fix the `dashboard.service.ts` literal. Card: `task-1781667815009-9c4anu` — **STILL VALID** (location corrected, scope narrowed on the api side).

---

## LOW

### 10. App dead "Create Event" CTA + no 404 route
- `app src/pages/Home.tsx:257` links to `/create-event` — there is no matching `<Route>` and no catch-all `*` in `src/App.tsx` (routes: `/`, `/events`, `/events/:id`, `/login`, `/payment`, `/tickets/:ticketId`, `/my-tickets`, `/contact`, `/why-yebotickets`) → blank page.
- **Fix:** point the CTA at `/contact` (or remove it); add a NotFound catch-all route. Card: `task-1781667815732-pmsy1c` — **STILL VALID**.

### Other low-value items (documented, not filed)
- `api src/services/auth.service.ts` + `organizer.controller.ts` — `JWT_SECRET || 'fallbacksecret'` fail-open; throw at startup if unset.
- Dead code: `app src/components/EventDetails.tsx` (pre-overhaul legacy path); unused `mongodb` dep in `app/package.json`; eneza-ads template mock pages in `customer-dashboard` (`events/Ticket.tsx`, `components/TransactionTable.tsx`).
- `scanner-app` debug `print()`s in the controllers; `customer-dashboard` build still runs with `TSX_COMPILE_ON_ERROR=true` (`package.json:8`) — a latent masking flag worth removing once the tree is verified clean (the specific 17 errors it used to mask are gone — see resolved card 6).
- `admin-dashboard` has no payouts/refunds surface and no pagination on tables — expected for v1, listed for backlog.

---

## WITHDRAWN / CORRECTED (re-verification findings)

### ❌ 1. "Tickets are issued for FREE — YeboPay never wired" — **WITHDRAWN (FALSE on `main`)**
Original card `task-1781667777164-bcce40`. The first pass read an abandoned pre-payment WIP branch. On `origin/main` the full YeboPay flow **is implemented**:
- `api src/services/ticket.service.ts` imports `createCharge` from `./yebopay.service` and `purchaseTicket` does **reserve → `createCharge` → `finalizeReservedTicket` on `SUCCEEDED` / `releaseReservedTicket` on `FAILED`**, persisting a PENDING hold for async mobile-money (the dominant rail here) until a webhook/reconcile settles it. Free issuance happens **only for price-0 tickets**.
- Payment fields are written: `finalizeReservedTicket` sets `paymentRef`/`paymentStatus`/`amountPaid` (`ticket.service.ts` ~:558-575).
- `GET /api/tickets/payment-options` **exists** (`api src/routes/ticket.routes.ts:97`, `getPaymentOptionsController`, documented as backed by YeboPay `GET /v1/payment-options`) — exactly the contract the **app** was built against. There is **no app↔API mismatch**.
- Async settlement (webhook + reservation-reclaim sweep) is implemented in `ticket.service.ts` (the "Asynchronous settlement" section) and `payment-webhook.service.ts` (with tests).
- **Action:** withdraw card `bcce40`. (If a genuine residual hardening item exists — e.g. atomicity of the reserve claim or quantity handling — it should be re-filed only after fresh verification against `main`, not carried over from the stale text.)

### ❌ 3. "Scanner silent-accept — stale-cached ticket shown valid on online error" — **WITHDRAWN (FALSE on `main`)**
Original card `task-1781667778632-ldzi6b`. The described architecture (`_lookupOnline`/`_lookupOffline`, an open-time manifest cache, an `isOnline` toggle at `ticket_scanner_controller.dart:137-152`) **does not exist anywhere in the scanner on `main`**. The real controller (`scanner-app lib/controllers/ticket_scanner_controller.dart`) is **online-only**: it calls the API and, on any error, sets `ticketData.value = {'error': ...}`; `checkInTicket` returns `{success:false}` when `response['error'] == true`. There is no cache to fall through to and no silent accept. A repo-wide search for `offline`/`manifest`/`isOnline`/`_lookupOffline` returns nothing.
- **Action:** withdraw card `ldzi6b`. (The first pass's "scanner offline queue with orange banner, unit-tested" false-positive note is likewise stale — no offline path exists.)

### ✅ 6. "Organizer Event-Details cancel/refund + Create-Event are type-broken" — **RESOLVED on `main`**
Original card `task-1781667798185-8yyy6w`. Fixed by intervening work:
- `customer-dashboard src/lib/event-api.ts:35` `createEvent` now takes `CreateEventInput` and returns `ApiEvent`; `CreateEvent.tsx:121-125` calls it and reads `event.id` correctly. The new `CreateEventInput`/`ApiEvent` types in `types/event.ts` are wired in.
- `EventDetails.tsx` no longer references `cancelEvent`/`refundTicket` — a repo-wide search for those symbols returns **zero** hits. The cited breakage is gone.
- `TSX_COMPILE_ON_ERROR=true` remains in the build script (folded into the LOW backlog above), but the specific 17 errors it masked no longer exist.
- **Action:** mark card `8yyy6w` resolved.

---

## Healthy components (do NOT re-investigate)

- **app (public buyer)** — production-shaped: full browse→select→auth(OTP)→pay→QR flow wired to the live API (including the real `GET /tickets/payment-options` contract), no silent fallbacks. The "frontend UI incomplete" KB note is **stale**.
- **admin-dashboard** — CoreUI shell with a small set of clean custom files: DRY shared client that throws loudly, real Prisma-backed KPIs, no mock data, server-side `authorize(ADMIN)` on all mutations. Only dependency is backend leak #2.

## False positives rejected (do NOT re-file)
- Two-step check-in (`confirmCheckIn`) is race-safe via conditional `updateMany`.
- Cross-organizer check-in IDOR is fixed (`assertEventAccess`); event update/delete scope by `{id,organizerId}` for non-admins.
- YeboPay/Keshless clients themselves are correctly written (throw on non-2xx/missing key) — **and they ARE called** (see withdrawn card 1).
- No direct Stripe/MoMo/SendGrid/Twilio anywhere; unused `StripeBuyButton.tsx` files are unrouted.
- No self-service refund/cancel beyond YeboPay = consistent with the YeboPay-only standard, not a gap. (Backend `POST /api/tickets/refund/:ticketId` + event-cancel routes exist for organizer/admin use.)

## Standards deviation (architecture-level, flagged not filed)
Consumer auth is **custom phone+OTP+JWT, not YeboID** (`api auth.service.ts`; app/scanner login). The product stores its own `phoneNumber`/`email`/`name` instead of a `yeboidUserId` FK. Per Omevision standards consumer auth should be YeboID. This is pervasive (entire `User` model + auth flow across api/app/scanner) — a dedicated migration epic, not a line-level gap.
