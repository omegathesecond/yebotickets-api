Administrative suspension uses User.isSuspended. Phone ownership remains User.isVerified; existing unverified accounts are not inferred to be suspended. Deploy the additive migration before the API revision. No account, event, admission, purchase, refund or payout history is mutated by this action.

The admin status endpoint now requires a JSON boolean isSuspended. The admin dashboard must ship with this contract. It no longer accepts verification as suspension.

Integration with pending tasks:
- Password-session invalidation branch omevision/task-1793199757988-29jeib-invalidate-existing-sessions-when-organi changes the same middleware and refresh select. Keep BOTH sessionVersion and isSuspended selects/checks when resolving these hunks; keep version-aware token minting. Reactivation does not reset sessionVersion or revive password-revoked sessions.
- Verified-buyer upgrade branch omevision/task-1793199756318-ndklo0-require-verified-account-ownership-befor changes becomeOrganizerController and OTP response shape. Preserve its ownership checks; never add isSuspended to self-service updates or OTP writes. Suspension is checked from the current database row on every protected request and refresh, regardless of token issuance route.

Verification: npm run build && npm test -- --runInBand. Suspension controller and route regressions use real signed JWTs with a mocked persistence boundary; they do not require a live database or send OTP messages.
