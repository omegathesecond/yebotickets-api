# YeboTickets — Gap Scan (2026-07-01, round 3)

Task `task-1781728500999-10uv7e`. Full-fleet audit of all five component repos
(api, app, customer-dashboard, admin-dashboard, scanner-app) against the
Omevision platform standards (YeboID auth, YeboPay payments, YeboLink comms,
**no silent fallbacks**) and for missing/incomplete features.

Every finding below was **verified line-by-line against the current default
branch** of each repo (worktree HEADs == `origin/main`):
api `8a6f1cb`, app `a7324b1`, customer-dashboard `162c480`,
admin-dashboard `351d4ca`, scanner-app `1ea62a1`. Round-1
(`task-1781665508533`) and round-2 (`task-1781692203620`) are superseded by this
doc; their resolved cards are summarized under "Resolved since round 2" and are
NOT re-filed.

## Overall verdict

**YeboTickets is mature and production-shaped.** The backend money-path is the
strongest part of the codebase and needs no rework: ticket reservation is
race-safe (pre-generated per-seat rows + lock-free compare-and-set `updateMany`
claims — no oversell), YeboPay reserve→charge→finalize/release is correct and
never issues a ticket without a `SUCCEEDED` charge, PENDING mobile-money holds
are reclaimed by authoritative `GET /v1/charges/:id` polling, webhooks are
HMAC-verified over the raw body and settle exactly-once, refunds call YeboPay
first and only mark `REFUNDED` on confirmed money-back (surfacing a 501
no-adapter loudly instead of faking it), and all comms go through YeboLink (the
old direct-Meta WhatsApp path is gone). `tsc` is clean and all 92 api tests pass.

The residual gaps have **migrated to the edges**: a handful of fabricated UI
surfaces that violate the no-silent-fallback rule, dead CTAs, a token-in-logs
leak on the scanner, two security-hardening items, and two missing
trust-&-safety surfaces (event moderation, organizer payouts). None are defects
in the money-path.

## Newly filed this round

| Card | Sev | Component | Gap |
|------|-----|-----------|-----|
| app fabricated availability | MED | app | Event browse/featured cards hardcode `ticketsAvailable:1, ticketsSold:0` (`EventList.tsx:117`), so every card renders a green **"Available"** badge (`EventCard.tsx:53,158-160`) and a genuinely sold-out event still shows as buyable. No availability comes from the list endpoint. **Silent-fallback / buyer-trust violation.** |
| scanner JWT in logs | MED (sec) | scanner-app | The bearer JWT and full user record are written to device logs via `print()` in **release** builds: `storage_service.dart:9,14`, `api_service.dart:28,91`, `auth_controller.dart:66`. Any app with log access or a crash-reporter can lift a live session token. |
| api JWT fallbacksecret | MED (sec) | api | `token.service.ts:22,24` sign access + refresh tokens with `process.env.JWT_SECRET \|\| 'fallbacksecret'`. If `JWT_SECRET` is ever unset, tokens are signed with a public constant (forgery). Throw at startup instead. |
| admin event moderation | MED | admin-dashboard | Events table is read-only (`EventsPage.tsx:84-118`), but the API already authorizes admin unpublish/cancel/delete (`event.routes.ts:169,204,239`). Admins have **no way to take down a fraudulent/abusive event** from the console. Wire take-down CTAs to the existing admin routes. |
| organizer dashboard dead surfaces | MED | customer-dashboard | Sidebar footer dropdown items **Account/Earnings/Notifications** have no `onClick` (`app-sidebar.tsx:206,210,214`) — dead clicks; a fake `plan:'Enterprise'` badge (`:86,118`); and the landing "Recent Notifications" card is a hardcoded fake array (`Dashboard.tsx:47-60`) with no backing endpoint. Wire or remove each. |
| frontend template cleanup | LOW | app + customer-dashboard | Dead eneza-ads template cruft still shipped and pulling junk prod deps into Vite frontends. customer-dashboard: `TransactionTable.tsx`, `pages/events/Ticket.tsx`, `types/advertiser*.ts`, `types/ad.ts`, `constants/mock-api.ts`, `constants/data.ts`, `lib/store.ts`, `lib/menu-list.ts`, `breadcrumbs.tsx`, `hooks/use-breadcrumbs.ts`, Next.js leftovers `middleware.ts`+`auth.ts` (the only reason `mongoose`+`@faker-js/faker` are deps); rename package from `eneza-customer-dashboard`, drop `TSX_COMPILE_ON_ERROR`. app: unused `mongodb`+`@types/mongodb`+stray `install`/`npm` deps, dead `components/EventDetails.tsx`. |

## Still valid — already tracked, NOT re-filed

- **`GET /events?showUnpublished=true` leaks drafts** (`lpfuek`, HIGH sec) — the
  fix (`security: gate showUnpublished on GET /events to admins only`) is on the
  **approved-but-unmerged** branch
  `omevision/task-1781667777873-lpfuek-security-get-events-showunpublished-true`
  (commits `45a6865`, `7f75411`). On `main` the route `event.routes.ts:103` is
  still ungated and `event.service.ts:94` still honors the flag for anyone.
  **Action: merge the lpfuek branch** — no new card.
- **Currency `KES` mislabel** (`9c4anu`, MED) — `dashboard.service.ts:76` is the
  filed instance. Round-3 found a **second live instance**:
  `organizer.controller.ts:229` also hardcodes `currency:'KES'` for the
  `GET /api/user/events` stats block. Fold into the existing currency card
  (fix both; the rest of the api correctly uses `TICKET_CURRENCY='SZL'`).
- **App dead `/create-event` CTA + no 404 catch-all** (`pmsy1c`, LOW) — still
  valid: `app/src/pages/Home.tsx:257` links to a non-existent route;
  `App.tsx:26-36` has no `<Route path="*">`.
- **Missing organizer payouts surface** — genuine platform gap (no payout/
  disbursement route in the api, no UI). Organizers can't be paid out
  in-product. A feature epic, not a line-level defect — left as a note for a
  product decision, not filed as a bug this round.

## Resolved since round 2 (do NOT re-file)

- **Comms bypass YeboLink** (`bydl5v`) — RESOLVED. `whatsapp.service.ts` deleted;
  `comms.service.ts`→`yebolink.client.ts` for all SMS/WhatsApp/email; zero
  `graph.facebook.com` refs.
- **Organizer dashboard-stats/monthly-stats 404** (`2om6g3`/`2iimhf`) — RESOLVED.
  `/user/dashboard-stats` + `/user/monthly-stats` exist and are gated
  (`user.routes.ts:57,75`, `protect`+`authorize(ORGANIZER,ADMIN)`), backed by
  real sold-row counts/revenue in SZL (`organizer-event.service.ts`). The
  customer-dashboard landing KPIs + sales chart now render real data with a loud
  error state. (Only the fake *notifications* card on that page remains — folded
  into the round-3 "dead surfaces" card above.)
- **Fabricated organizer stats always 0** (`pbcuvk`) — RESOLVED both sides:
  `organizer.controller.ts:216-226` computes real `totalSold`/`totalRevenue`;
  scanner `profile_screen.dart` renders a `FutureBuilder` over
  `/organizers/dashboard` (no `15/1560/31200` literals remain).
- **OTP endpoints unthrottled** (`fj9aud`) — RESOLVED (rate-limit + attempt cap).
- **Reservation reclaim never scheduled** (`4ilqk0`) — RESOLVED (global sweep,
  gated to a single instance cross-instance).
- **Scanner silent-accept at the gate** (`ldzi6b`) — RESOLVED and re-verified:
  the scanner now ships a full offline cache + queue + conflict-replay system,
  and it is **fail-loud** — the offline path accepts only codes in the pre-synced
  sold set, unknown/forged/wrong-event codes are red-rejected, and server
  rejections surface as-is. Never silently accepts a revoked/refunded ticket.
- **Dead organizer menu links / cancel-refund type breakage / login flow**
  (`afudqe`,`8yyy6w`) — RESOLVED (live nav is `app-sidebar.tsx`; real
  `/organizers/login`).

## Healthy components — do NOT re-investigate

- **api money-path** — reservations, YeboPay charge/finalize/release, webhook
  settlement, PENDING reclaim, refund/cancel: all real, race-safe, idempotent,
  fail-loud. No TODOs/stubs in `src/`. Tests + `tsc` green.
- **admin-dashboard** — hand-built React/Vite (no CoreUI template pages), real
  Prisma-backed KPIs, no mock data, every mutation server-gated
  `authorize(ADMIN)`, all called endpoints exist, loud error states. Its only
  actionable items are the API-side draft leak (tracked) and the missing
  moderation/payouts surfaces (filed/noted above).
- **app money/auth path** — fresh idempotency key per ticket, 201-issued vs
  202-pending discrimination, loud "X of N processed" accounting, 401 re-auth,
  pending-hold rendering with no fake QR. No silent fallbacks on the pay path.

## Standards deviation (architecture-level, flagged not filed)

Consumer auth is **custom phone+OTP+JWT, not YeboID**; the product stores its own
`phoneNumber`/`email`/`name` instead of a `yeboidUserId` FK. Per Omevision
standards consumer auth should be YeboID. This is pervasive (entire `User` model
+ auth flow across api/app/scanner) — a dedicated migration epic, not a
line-level gap. Unchanged since prior rounds.
