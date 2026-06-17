# YeboTickets — Gap Scan (2026-06-17)

Full-fleet audit of all five component repos (api, app, customer-dashboard, admin-dashboard, scanner-app) against the Omevision platform standards (YeboID auth, YeboPay payments, YeboLink comms, **no silent fallbacks**) and for missing/incomplete features.

**Headline: YeboTickets is the LEAST mature product audited so far, and the gaps are revenue-critical.** Unlike YeboJobs/YeboDash (mostly-complete, API-only gaps), YeboTickets has a **money hole at its center**: tickets are issued for free because YeboPay was never wired into the purchase path — even though the app frontend was fully built against a YeboPay contract the API doesn't implement. The customer-dashboard ships type-broken code (errors masked by `TSX_COMPILE_ON_ERROR`), and the scanner has a silent-accept gate vulnerability. The public buyer **app** and the **admin-dashboard** are the two healthy components.

10 `gap-scan` backlog cards filed. This document is the durable record; cross-references are by `repo file:line`.

---

## CRITICAL

### 1. Tickets are issued for FREE — YeboPay never wired; app/API payment contract mismatch
- `api src/services/ticket.service.ts:453-508` (`purchaseTicket`) finds an `available` Ticket, flips it to `sold`, delivers a QR — **never calls YeboPay or Keshless**. `grep` confirms zero usages of `createCharge`/`acceptPayment` outside the unused service files. `paymentRef`/`paymentStatus`/`amountPaid` (`schema.prisma:153-155`) are never written.
- The **app** was built for a full YeboPay flow the API lacks: `app src/services/apiService.ts:71-105` calls `GET /api/tickets/payment-options` (**no such route exists in the API**), posts a `payment` body (paymentMethodId / providerCode+phone), and handles `201`-issued vs `202`-pending mobile-money holds (`app models/Event.ts:191`).
- Co-located bugs to fix in the same function: **(a) oversell race** — non-atomic `findFirst({status:available})` then separate `update()` by id (`:468-488`); two concurrent buyers claim the same seat. **(b) quantity ignored** — documented in `ticket.routes.ts:86-92` but never read (`ticket.controller.ts:121-140`); only 1 ticket ever issues.
- **NOTE:** an abandoned WIP branch (`omevision/task-1780900787109-ipn6sa`) already contains `yebopay.service.ts`, `keshlessPayment.service.ts`, and an `add_ticket_payment_fields` migration — payment scaffolding was started and never connected. The clients are now on `main`.
- **Fix:** add `GET /tickets/payment-options`; in `purchaseTicket` charge via YeboPay (sync 201 + async 202 hold), require `SUCCEEDED` before issuing, persist payment fields, **fail loudly (issue NO ticket) on non-success**, atomic claim, honor quantity.
- Card: `task-1781667777164-bcce40`

---

## HIGH

### 2. `GET /events?showUnpublished=true` leaks unpublished/draft events to the public
- `api src/routes/event.routes.ts:74` — `router.get('/', getEventsController)` has **no `protect`**; `getEventsController` (`event.controller.ts:33-44`) passes `req.query` through and `event.service.ts:88` honors `showUnpublished=true` for anyone. The admin dashboard depends on this exact call (`admin-dashboard admin-events.js:85`).
- **Fix:** ignore the flag unless `req.user?.role==='admin'`. Card: `task-1781667777873-lpfuek`

### 3. Scanner silent-accept — stale-cached ticket shown "valid" when the online check-in errors
- `scanner-app lib/.../ticket_scanner_controller.dart:137-152` (`_lookupOnline`): on `error==true`, if the ticket is in the open-time manifest cache it falls through to `_lookupOffline` and can show green/`canCheckIn` from stale data. A ticket revoked/refunded/checked-in after open that triggers any non-200 is **accepted** → free entry.
- Compounded by `ticket_api.dart:14-44` collapsing every exception (incl. 4xx) into one opaque `{error:true}` shape, so the controller can't tell "server rejected" from "network blip".
- **Fix:** only fall back to cache when genuinely offline (`!isOnline.value`); preserve HTTP status/error code so 4xx surfaces loudly. Card: `task-1781667778632-ldzi6b`

### 4. Comms bypass YeboLink — direct Meta WhatsApp Cloud API
- `api src/services/whatsapp.service.ts:1-12` posts to `graph.facebook.com` with `WHATSAPP_API_TOKEN`; OTP (`auth.service.ts:80`) and ticket delivery (`ticket.service.ts:426`) both use it. `.env.example` documents no YeboLink key. Violates the all-comms-through-YeboLink standard.
- **Fix:** YeboLink client bound via `YEBOTICKETS__YEBOLINK_API_KEY[_DEV]` (`/yebolink-implementation`). Card: `task-1781667779271-bydl5v`

### 5. Organizer dashboard landing page always 404s + fake notifications
- `customer-dashboard src/pages/dashboard/Dashboard.tsx:74-75` fetches `GET /user/dashboard-stats` and `/user/monthly-stats` — **neither exists** on the API (`user.routes.ts` has only `/user/events`; `/dashboard/metrics` is admin/API-key-only). The default organizer landing page (KPIs + sales chart) renders the red error state for every organizer.
- `Dashboard.tsx:47-60` "Recent Notifications" is a hardcoded fake array presented as live activity (no-silent-fallback violation).
- **Fix:** add organizer-scoped `dashboard-stats`/`monthly-stats` endpoints; back or remove notifications. Card: `task-1781667797539-2iimhf`

### 6. Organizer Event-Details cancel/refund + Create-Event are type-broken (errors masked)
- Builds only because the build script sets `TSX_COMPILE_ON_ERROR=true` (17 tsc errors masked).
- `customer-dashboard src/pages/events/EventDetails.tsx:103,130` call `eventApi.cancelEvent` / `refundTicket` — **neither defined** in `src/lib/event-api.ts` (backend routes DO exist: `POST /api/tickets/refund/:ticketId` + event-cancel).
- `src/pages/events/CreateEvent.tsx:213,223` pass the new `location:{…}`/`startDate`/`isPublished` shape and read `event.id`, but `event-api.ts:28 createEvent` still uses the legacy `Event` type (`location:string`, `_id`). New `CreateEventInput`/`ApiEvent` interfaces were added to `types/event.ts` but never wired in.
- **Fix:** add the two client methods; switch `createEvent` to `CreateEventInput`→`ApiEvent`; commit in-flight WIP; turn OFF `TSX_COMPILE_ON_ERROR`. Card: `task-1781667798185-8yyy6w`

---

## MEDIUM

### 7. Fabricated stats shown as real (no-silent-fallback violations)
- `api src/controllers/organizer.controller.ts:189-199` — `totalSold`/`totalRevenue` are always returned as `0` (loop only increments `totalTypes`); organizers see zero sales regardless of reality.
- `scanner-app lib/.../profile_screen.dart:61-63` — hardcoded `15` events / `1,560` sold / `$31,200` revenue.
- **Fix:** compute real counts/sums; remove scanner literals. Card: `task-1781667798919-pbcuvk`

### 8. Organizer self-service stubs are dead CTAs
- `customer-dashboard` Profile (`profile/Profile.tsx:23,44` — Save/Update-Password no-op; change-password endpoint exists), Settings (`settings/Settings.tsx:88` — inert, eneza "ad campaigns" copy residue), Support (`support/Support.tsx:54` — inert). `src/lib/menu-list.ts` links to non-existent routes (`/events/new`, `/tickets`, `/scanner`, `/insights`, `/account`).
- **Fix:** wire Profile change-password; implement/hide Settings/Support; fix copy; align menu hrefs. Card: `task-1781667814243-afudqe`

### 9. Wrong/inconsistent currency — market is Eswatini (SZL/E)
- `api src/routes/dashboard.routes.ts:127` hardcodes `currency:'KES'`. `app src/components/EventCard.tsx:65,74` defaults `ZAR` + `en-ZA` formatting (real `TICKET_CURRENCY='SZL'`). `scanner-app profile_screen.dart` shows `$`.
- **Fix:** standardize on SZL/E everywhere. Card: `task-1781667815009-9c4anu`

---

## LOW

### 10. App dead "Create Event" CTA + no 404 route
- `app src/pages/Home.tsx:257-261` links to `/create-event` — no `<Route>` and no catch-all in `src/App.tsx:28-37` → blank page.
- **Fix:** point CTA at `/contact` or remove; add a NotFound route. Card: `task-1781667815732-pmsy1c`

### Other low-value items (documented, not filed)
- `api src/services/auth.service.ts:19` + `organizer.controller.ts:17` — `JWT_SECRET || 'fallbacksecret'` fail-open; throw at startup if unset.
- `api src/services/ticket.service.ts:680-722` (`verifyTicket`, legacy `/verify` path) lacks the conditional `updateMany` claim that `confirmCheckIn` has → double check-in race on that path; deprecate `/verify` or harden it.
- Dead code: `api src/app.ts` (stale duplicate express app); `app src/components/EventDetails.tsx` (pre-overhaul, has the only `alert()` + legacy `deltapayAccountId`/ZAR path); `customer-dashboard src/pages/events/index.tsx`, `events/Ticket.tsx`, `components/TransactionTable.tsx` (eneza-ads template mock data, unrouted); unused `mongodb` dep in `app/package.json`.
- `scanner-app main.dart:61` boots `/onboarding` on every launch (the `isLoggedIn` SplashScreen at `/` is never the entry point); debug token `print()`s in `api_service.dart:90` + `auth_controller.dart:65`; `mobile_scanner` imported but only a transitive dep.
- `admin-dashboard` has no payouts/refunds/payment-ops surface and no pagination on organizers/events tables — expected for v1, listed for backlog.

---

## Healthy components (do NOT re-investigate)

- **app (public buyer)** — ~90% complete, production-shaped: full browse→select→auth(OTP)→pay→QR flow wired to the live API, no silent fallbacks (every `catch` surfaces an error), YeboPay-only payment picker. The "frontend UI incomplete" note is **stale**. (Its payment UI is held back only by the missing API side — gap #1.)
- **admin-dashboard** — CoreUI template shell with 8 custom files; the custom code is the cleanest in the fleet: DRY shared client that throws loudly on every failure, real Prisma-backed KPIs, no mock data, server-side `authorize(ADMIN)` on all mutations. Only finding it depends on is the backend leak #2.

## False positives rejected (do NOT re-file)
- Two-step check-in (`confirmCheckIn`, `ticket.service.ts:796-814`) is race-safe via conditional `updateMany` — the race only survives on the legacy `/verify` path.
- Cross-organizer check-in IDOR is fixed (`assertEventAccess`, `ticket.service.ts:598-614`); event update/delete scope by `{id,organizerId}` for non-admins.
- Scanner offline path does NOT fake-accept: unknown tickets rejected, offline flagged with an orange banner, double-scan guarded by `isCheckedIn` + queue-contains (unit-tested). The ONLY scanner gap is the online-error→cache downgrade (#3).
- YeboPay/Keshless clients themselves are correctly written (throw on non-2xx/missing key) — the gap is that they're never *called*, not that they fall back.
- No direct Stripe/MoMo/SendGrid/Twilio anywhere; `app StripeBuyButton.tsx`/`customer-dashboard StripeBuyButton.tsx` are unused/unrouted.
- Admin client-only role check is UX-only; real enforcement is server-side `authorize(ADMIN)`.
- No self-service refund/cancel beyond YeboPay = consistent with the YeboPay-only standard, not a gap.

## Standards deviation (architecture-level, flagged not filed)
Consumer auth is **custom phone+OTP+JWT, not YeboID** (`api auth.service.ts`; app/scanner login). The product stores its own `phoneNumber`/`email`/`name` instead of a `yeboidUserId` FK. Per Omevision standards consumer auth should be YeboID. This is pervasive (entire `User` model + auth flow across api/app/scanner) — a dedicated migration epic, not a line-level gap.
