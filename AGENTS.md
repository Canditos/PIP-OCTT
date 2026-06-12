# Project: OCPP Certification Pipeline

## Architecture
OCPP certification dashboard integrating OCTT cloud (test execution), CDS hardware (EV simulator), and Jira (issue tracking). Express backend serves a SPA frontend with SSE for real-time updates.

## Stack
- **Backend**: Express + TypeScript, run via `tsx`
- **Frontend**: Vanilla JS SPA, Chart.js CDN
- **Testing**: Playwright (serial, `--workers=1`)
- **Hardware**: Keysight CDS (SLEP protocol over TCP)

## Key Files
- `src/apps/certification-dashboard/server.ts` — Express bootstrap (~150 lines)
- `src/apps/certification-dashboard/services/pipeline.service.ts` — Playwright runner + phased pipeline (reboot/normal tests), run history persistence
- `src/apps/certification-dashboard/routes/` — Modular routes: cds, octt, jira, pipeline, status, logs, relay, testcases, results, reports, config, sut, docs
- `src/apps/certification-dashboard/public/index.html` — Full SPA frontend with tabs, results table, history, charts, defect button
- `src/connectors/jira/jira-client.ts` — Jira REST API v3 client (create, search, transitions, attachments)
- `src/connectors/cds/` — CDS SLEP protocol connector
- `src/connectors/octt/` — OCTT REST API client
- `tests/certification_pipeline.spec.ts` — Playwright test suite: 25 suites, 113 tests
- `scripts/output/xray-import/` — Xray JSON import artifacts
- `scripts/test-steps/` — 113 step CSVs per test case
- `start.ps1` / `start.cmd` — One-command setup + launch
- `dashboard-config.json` — Persisted config (gitignored)

## Current State (HEAD b71b566)

### Done
- Modular architecture: routes/services/config layers
- Phased pipeline: reboot tests first (600/650s timeouts), then normal tests (70/450)
- Verdict parsing: regex `\s*→\s+(\S+):\s+(PASS|FAIL|ERROR|INCONC)\s+\(([\d.]+)s\)/i` matching `→ TC_062_CS: PASS (1786s)` format
- Inline duration fallback from ok/not ok Playwright lines
- Run history persistence (`logs/runs-history.json`, max 50 runs)
- Tab navigation: Current Run / Run History with Chart.js (pie + bar charts)
- "Create Defect" button on failing tests → Jira Bug with AI-generated description
- OCTT/CDS/Jira service auto-check on startup with SSE indicator
- 113 test suite catalog, 25 suites
- CDS relay routes (stop/reset/start)
- No-CDS quick-select button in test modal
- Config encryption via AES-256-GCM

### Blocked / Known Issues
- OCTT cloud proxy 10-min hard timeout → 504 on reboot tests (treated as inconc)
- OCTT `downloadReports` with `logfile_name` returns 0 bytes
- SUT disconnects from OCTT WebSocket during long reboot tests
- Cannot automate initial OCTT token acquisition (email OTP)

## Ports
- Dashboard: 3101
- OCTT: HTTPS (cloud)
- CDS: 51001 (TCP)

## Key Commands
- `start.ps1` / `start.cmd` — Setup + launch
- `npx tsx src/apps/certification-dashboard/server.ts` — Start manually
- `npx vitest run` — Unit tests (29 tests)
- `npx playwright test --workers=1` — Pipeline tests
