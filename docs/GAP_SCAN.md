# YeboTickets — Gap Scan (2026-06-17, round 2)

Task `task-1781692203620-txzibo`. Every finding below was verified against the
**current `origin/main`** of each component repo (the worktree HEADs equal
`origin/main`: api `840da31`, app `a7324b1`, customer-dashboard `a0991cb`,
admin-dashboard `351d4ca`, scanner-app `8b8ec8f`). The round-1 scan
(`task-1781665508533`) was blocked because it verified against a stale working
tree — this pass re-pins everything to the canonical ref.

## Overall verdict

YeboTickets is **healthy and production-shaped**. Buyer app, scanner check-in,
admin dashboard, payments (YeboPay), and comms (YeboLink) are all real and wired.
The gaps are an open auth-hardening hole, a cross-repo organizer-dashboard
dependency, and some placeholder/fabricated surfaces.

## Newly filed this round

| Card | Sev | Component | Gap |
|------|-----|-----------|-----|
| `task-1781693730230-fj9aud` | HIGH | api | OTP endpoints have **no rate-limiting / no attempt cap** — brute-forceable + SMS-spam vector. `auth.routes.ts:21-22`, no limiter anywhere in `api/src`. |
| `task-1781693730953-2om6g3` | HIGH | api | Organizer **dashboard stats endpoints don't exist** (`/user/dashboard-stats`, `/user/monthly-stats`, `/user/recent-activity`). `user.routes.ts:34` only has `/events`. The frontend fix (branch `2iimhf`) is stranded — it assumes these exist on the API. |
| `task-1781693731619-4ilqk0` | MED | api | `reclaimExpiredReservations()` (`ticket.service.ts:834`) is **never scheduled** — only called best-effort per-purchase (`:989`). Stranded PENDING holds linger until the next buyer attempt on that type. |
| `task-1781693732222-embj7c` | MED | customer-dashboard | Organizer **Settings & Support pages are dead placeholders** — `Settings.tsx:88,30,39,51-73` + `Support.tsx:54` have buttons/switches/selects with no handlers. |

## Resolved since round 1 (do NOT re-file)

- **Comms bypass YeboLink** (`bydl5v`) — RESOLVED. `whatsapp.service.ts` deleted;
  OTP + ticket delivery now go through `comms.service.ts` → `yebolink.client`
  (`api/src/services/comms.service.ts`). Zero `graph.facebook.com` references.
- **Scanner silent-accept at the gate** (`ldzi6b`) — RESOLVED (commit `863d374`).
  `api_exception.dart` preserves an `isNetworkError` flag; the scanner screen
  gates on `error == true` and shows amber "could not reach server / try again"
  for network blips vs red "ticket not accepted" + reason for server rejections.
  Never silently accepts a revoked/refunded ticket.
- **customer-dashboard cancel/refund + CreateEvent type-broken** (`8yyy6w`) — RESOLVED.
- **Dead organizer menu links** (`afudqe`) — RESOLVED. Old `lib/menu-list.ts`
  deleted; menu now in `app-sidebar.tsx:36-81`, every link maps to a real route.
- **customer-dashboard login flow** — RESOLVED (commit `350c264`): real
  `/organizers/login`, correct token/refreshToken unwrap, loud errors.

## Still valid — already tracked from round 1 (NOT re-filed)

- **`GET /events?showUnpublished=true` leaks drafts** (`lpfuek`, HIGH sec) — still
  valid: `event.routes.ts:103` is unauthenticated; `event.service.ts:94` drops the
  `isPublished:true` filter for anyone passing the flag. Gate behind organizer/admin.
- **Fabricated organizer stats** (`pbcuvk`, MED) — still valid on both sides:
  `organizer.controller.ts:203-213` leaves `totalSold`/`totalRevenue` at 0 (loop only
  counts `totalTypes`); scanner `profile_screen.dart:61-63` hardcodes
  `15 / 1,560 / $31,200` (also wrong `$` currency for the SZL market).
- **Wrong currency `KES`** (`9c4anu`, MED) — still valid: `dashboard.service.ts:76`
  hardcodes `currency:'KES'`; the rest of the api correctly uses SZL.
- **App dead `/create-event` CTA + no 404 catch-all** (`pmsy1c`, LOW) — still valid:
  `app/src/Home.tsx:257` links to `/create-event` (no such route); `App.tsx` has no
  `<Route path="*">`, so the link lands on a blank page.
- **Organizer dashboard landing** (`2iimhf`, frontend) — in-flight on branch
  `omevision/task-1781667797539-2iimhf`; **blocked on the new API card
  `2om6g3`** (the endpoints it calls don't exist on the API yet).

## Minor / not filed (notes for whoever touches these areas)

- scanner `profile_screen.dart:86-88`: "Change Password" button is a `Get.snackbar`
  "Coming Soon" stub even though `change_password_screen.dart` is fully implemented —
  a one-line wire-up (`Get.to(() => ChangePasswordScreen())`). Fold into `pbcuvk` or
  a scanner-polish pass.
- Two server entrypoints (`src/app.ts` has only `cors`; `src/server.ts` adds
  `helmet`). Confirm which one actually boots in prod so security middleware applies.

## Healthy — do NOT re-investigate

- **Buyer app**: full browse → OTP → pay → QR / async-mobile-money polling →
  WhatsApp delivery; SZL currency (`Event.ts:9`); no silent fallbacks; failed
  charges surfaced distinctly from network errors.
- **Scanner**: login, event selection, QR scan, manual entry, check-in verdict — all
  real and loud.
- **API payments**: YeboPay webhook HMAC-verified with timing-safe compare + 401 on
  bad sig (`payment-webhook.service.ts:85-116`); refund money-before-status-flip
  ordering; PENDING-charge idempotency; check-in race-safety via guarded `updateMany`;
  ownership choke-point `assertEventAccess`.
- **admin-dashboard**: real Prisma KPIs, server-side `authorize(ADMIN)`, loud client.
- **Comms**: YeboLink only. **No** direct Stripe / MoMo / Twilio / Meta.
