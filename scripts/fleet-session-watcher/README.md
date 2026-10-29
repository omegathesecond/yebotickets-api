# Fleet watcher repair candidate

This is a worker infrastructure patch retained with the incident, not API code.
Do not apply it to an API Cloud Run image. Deployment is outstanding; see
`docs/audits/2026-10-29-gap-scan-recovery.md`.

Validate in an isolated copy of the executing worker, preserving its dependencies:

```bash
patch -p1 --dry-run < worker.patch
patch -p1 < worker.patch
npx tsc --noEmit
node /path/to/regression.mjs src/handlers.ts /path/to/node_modules/typescript
npm test
```

The regression extracts and transpiles the actual watcher function with injected
tmux, timer, registry and finalization dependencies. It covers new launches during
harvest and query, overlapping ticks, replacement identity, live panes, and query
failure recovery. Against the original source, it must fail on the first new
launch assertion. Integrate in the managed worker's normal test/release pipeline;
do not hot edit a running worker or restart over active sessions.
