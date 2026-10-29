# Gap-scan session recovery — 2026-10-29

Recovery task: `incident-d3869b4ed125ff736c746c62`.
Original research task: `task-1793250848434-tugqxu`.

## Verified evidence

- Fetched API origin; production branch is `main`. The recovery branch and the original local gap-scan branch have no commits ahead of `origin/main` (`3d4a328`). No remote recovery branch exists at inspection time. There is no completed audit to advance.
- The dashboard's task read endpoint reports the original task as `queued`. Its manager note explicitly requests requeue and root-cause investigation before advancing the branch. No duplicate task was created and no legacy status helper was used.
- Failed session `01a18615-763b-7ad1-8bb7-b293b261627a` ran from 05:15:16.839Z to 05:15:23.354Z. The reported error is `Codex exited with code unknown`.
- The persisted rollout records two successful shell commands: listing project instruction/package files and reading the dashboard-sync skill. Both returned exit code 0. There is no subsequent audit, implementation, completion signal or recorded application failure. Reading that skill is not evidence that its legacy status helper executed.
- A live read of `/api/agent-sessions/01a18615-763b-7ad1-8bb7-b293b261627a/tail` returned failed status, an empty snapshot and null capture time. Available host journal reads for 05:15:14–05:15:26Z returned no matching records. The available Codex log database returned no WARN/ERROR rows in that interval. Absence of logs does not establish the cause of exit.
- A deployer read of Cloud Run dev reports revision `yebotickets-api-dev-00015-bk2` Ready and the dedicated `yebotickets-runtime` service account. Revision readiness alone does not prove application operation or resolve the separately documented disabled-health/database blockers. No deployment, migration or secret change was attempted.

## Disposition

The original research job is already requeued. Its failure is an agent-process interruption with an unknown cause, not a reproduced YeboTickets application defect. Do not attribute it to database, billing, Sentry, authentication or sandbox failure without additional evidence. Existing monitoring and production incidents remain separate; this recovery does not replace their revisions or widen their access.

Further root-cause repair needs the executing worker's exit code/signal and stderr or supervisor diagnostics for the failed session. The currently available transcript and empty stored tail cannot supply those facts. Preserve the failed session and original worktree for investigation. Do not signal implementation/deployment complete or fabricate a successful live-operation assertion.

This commit is an investigation handoff only. It changes no executable code, deployment configuration, environment or secret bindings. No Flutter run/build, payment, message, admission mutation or customer-data modification occurred.

## Rework: supervisor evidence and executable repair

The earlier unknown-cause disposition is superseded by retained supervisor output
in `/tmp/omevision-worker.log` on `omevision-fleet-1`:

- 05:15:14.731 UTC: the gap-scan tmux session starts successfully.
- 05:15:19.056–19.063 UTC: finalization of predecessor session
  `01a18611-dda2-72e3-8908-6938dc16f5ea` returns after asynchronous harvest.
- Immediately at 05:15:19.063 UTC the same watcher declares gap-scan session
  `01a18615-763b-7ad1-8bb7-b293b261627a` disappeared, starts failed finalization,
  and harvests its transcript before any recorded runner exit.
- 05:15:26.819 UTC: failed finalization explicitly kills the gap-scan tmux session.

The executing supervisor's `startSessionWatcher` queries tmux once, then iterates
its live `runningSessions` Map across asynchronous finalizations. Map iteration
visits newly inserted sessions absent from that earlier tmux snapshot. This is a
reproduced supervisor race, not evidence of a YeboTickets API or billing failure.
The related YeboJobs investigation already models this race at
`incident-8e627f07bbcf9ba67357cd4d/investigation/reproduce-worker-watcher-race.mjs`.
The new regression exercises the actual watcher source, rather than duplicating
that model.

`scripts/fleet-session-watcher/worker.patch` fixes candidate capture before any
await, excludes replaced session identities, prevents overlapping timer passes,
and releases the lock on errors while reporting tmux failures. Existing job-name
isolation changes in the running worker are preserved. `regression.mjs` accepts
the worker source and its TypeScript package path; it fails against the existing
watcher (new scan incorrectly finalized) and passes against the patched source.
Patch dry-run/application and the patched worker TypeScript check pass in an
isolated `/tmp/yebotickets-watcher-check` copy. The full worker suite is recorded
in `/tmp/yebotickets-watcher-tests.log`.

### Release remains incomplete

This product repo carries a reviewable fleet patch, not a deployed worker repair.
The live worker source is outside every product component repo and has no git
metadata at its runtime path. Its service uses `KillMode=process`, but startup
`reapOrphanTmux` kills agent sessions absent from the new in-memory registry.
Restarting it during active fleet work would therefore interrupt unrelated jobs.
Do not restart it or treat requeue as verification. The existing original scan
remains queued on the dashboard; no duplicate job or legacy status mutation was
made. No live scan recovery, verifyCmd success, or deployment completion is claimed.

Required next action is fleet-owner coordination through the worker release
pipeline: integrate this patch into the managed worker source, review it, drain
or safely adopt active sessions, deploy, then execute the existing original scan
and assert its actual accepted audit result. Before deployment completion, set
the task verifyCmd to read-only checks of that exact worker release and original
scan result. No completion signal is appropriate before recovered live operation.

Final validation: compiled isolated worker suite (`npm run build`, then
`node --test dist/*.test.js`) passes 45/45. Raw `npm test` passes 43/45 because
its two runner fixtures look for adjacent `src/codex-runner.js`, which only exists
under `dist` after compilation; this is an existing fixture-path issue, not a
watcher failure. Compiled results: `/tmp/yebotickets-watcher-compiled-tests.log`.
