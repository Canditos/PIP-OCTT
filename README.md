# OCPP Certification Automation Dashboard

> End-to-end OCPP certification pipeline integrating **OCTT** (OCA Compliance Testing Tool), **Keysight CDS** (SL1040A Charging Discovery System), and **Jira Cloud** for automated test execution, result tracking, and issue management.

## Overview

This project automates the complete OCPP certification workflow:

1. **Lab Preparation** — Configure the CDS EV simulator with the correct charge profile
2. **Test Execution** — Run OCTT compliance tests via REST API or Playwright
3. **Result Processing** — Sync failures to Jira with deduplication and severity classification
4. **Reporting** — Generate markdown summaries with pass rates and certification blockers

A web dashboard provides real-time monitoring via Server-Sent Events (SSE), manual service checks, test case selection, and one-click Jira uploads.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DASHBOARD FRONTEND                              │
│                         (src/apps/certification-dashboard/public)            │
│                              HTML + CSS + Vanilla JS                         │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ HTTP / SSE
┌──────────────────────────────────▼──────────────────────────────────────────┐
│                         CERTIFICATION DASHBOARD SERVER                       │
│                    (src/apps/certification-dashboard/server.ts)              │
│  Express + REST API + SSE streaming + Config persistence + Playwright runner │
└──────┬───────────────────────┬───────────────────────┬──────────────────────┘
       │ REST                  │ TCP/SLEP              │ REST
┌──────▼──────┐      ┌────────▼────────┐      ┌──────▼──────┐
│    OCTT     │      │  Keysight CDS   │      │ Jira Cloud  │
│  REST API   │      │  SL1040A (TCP)  │      │  REST API   │
│  OCPP Tests │      │  EV Simulation  │      │  Issue Mgmt │
└─────────────┘      └─────────────────┘      └─────────────┘
```

### Component Flow

```
Phase 1: Lab Setup
  Dashboard → CDS Client → TCP/SLEP → Keysight CDS (configure EV + start sim)

Phase 2: Test Execution
  Dashboard → OCTT Client → REST API → OCTT (start session → execute tests)

Phase 3: Result Processing
  ReportEntry[] → Dedup Engine → Jira Mapper → Jira Client → Jira Cloud
                    ↓
            Severity Classifier
                    ↓
            Execution Summarizer
```

---

## Project Structure

```
├── src/
│   ├── apps/
│   │   └── certification-dashboard/
│   │       ├── server.ts           # Main Express backend (SSE, REST API, Playwright runner)
│   │       └── public/
│   │           └── index.html      # Single-page dashboard UI
│   ├── connectors/
│   │   ├── octt/
│   │   │   ├── octt-client.ts     # High-level OCTT REST API client
│   │   │   ├── http-client.ts     # Axios wrapper with error translation
│   │   │   ├── types.ts           # OCTT API type definitions
│   │   │   └── index.ts           # Public exports
│   │   ├── cds/
│   │   │   ├── cds-client.ts      # Keysight CDS SLEP/TCP client
│   │   │   ├── types.ts           # CDS enums, PIDs, and type definitions
│   │   │   └── index.ts           # Public exports
│   │   └── jira/
│   │       ├── jira-client.ts     # Jira Cloud REST API v3 client
│   │       └── index.ts           # Public exports
│   ├── domain/
│   │   ├── dedup-engine.ts        # Jira issue deduplication logic
│   │   ├── severity-classifier.ts # Maps test failures to Jira priority
│   │   ├── jira-mapper.ts         # Transforms OCTT reports → Jira payloads
│   │   └── execution-summarizer.ts# Generates markdown execution summaries
│   └── orchestrator/
│       └── coordinator.ts         # End-to-end pipeline coordinator
├── tests/
│   ├── certification_pipeline.spec.ts  # Playwright E2E test suite
│   ├── certification_dashboard.spec.ts # Dashboard UI tests
│   ├── jira-mapper.test.ts            # Unit tests for Jira mapping
│   ├── execution-summarizer.test.ts   # Unit tests for summarizer
│   └── severity-classifier.test.ts    # Unit tests for severity classifier
├── sut-api-relay-agent/           # Python relay for OCTT SUT API forwarding
├── package.json
├── tsconfig.json
├── playwright.config.ts
└── README.md
```

---

## Setup

### Prerequisites

- **Node.js** 18+ with npm
- **Python** 3.8+ (for the SUT API relay agent)
- Network access to:
  - OCTT instance (Open Charge Alliance)
  - Keysight CDS (SL1040A)
  - Jira Cloud (optional, for issue tracking)

### Installation

```bash
# Clone or extract the project
cd octt-certification-dashboard

# Install Node.js dependencies
npm install
```

### Configuration

Create a `.env` file in the project root (copy from `.env.example` if available):

```bash
# OCTT
OCTT_BASE_URL=https://your-instance.octt.openchargealliance.org
OCTT_TOKEN=your_api_token_here
OCTT_OCPP_VERSION=ocpp1.6
OCTT_ROLE=CS

# CDS (Keysight SL1040A)
CDS_IP=192.168.100.10
CDS_PORT=51001

# Jira Cloud (optional)
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your_jira_api_token
JIRA_PROJECT_KEY=CERT

# Dashboard
CERT_DASHBOARD_PORT=3101
```

Alternatively, you can configure everything through the web UI — settings are persisted to `dashboard-config.json`.

---

## Running the Dashboard

```bash
# Development mode with auto-reload (requires tsx)
npm run dev:cert

# Or production start
npm start
```

The dashboard will be available at **http://localhost:3101**.

### What the Dashboard Provides

- **Real-time log stream** — SSE-powered console output from all services
- **Service health indicators** — CDS, OCTT, and Jira connection status
- **Test case selector** — Choose specific suites or individual tests
- **One-click execution** — Run selected tests via Playwright
- **Reboot test helpers** — Auto-adjust OCTT timeouts for cold-boot/reset tests
- **Jira integration** — Upload failures directly as bugs with attachments
- **Report viewer** — Inline CSV log inspection and ZIP downloads

---

## Running Tests

### Playwright E2E Certification Tests

```bash
# Run the full certification pipeline via Playwright
npx playwright test tests/certification_pipeline.spec.ts

# Run a specific test case
npx playwright test tests/certification_pipeline.spec.ts --grep "TC_001_CS"

# Run with UI for debugging
npx playwright test --ui
```

### Unit Tests (Vitest)

```bash
# Run all unit tests
npm test

# Watch mode
npm run test:watch
```

---

## Key Components

### 1. Certification Dashboard Server (`server.ts`)

The central backend that ties everything together:

- **REST API** for service checks, configuration, pipeline control, and report downloads
- **SSE streaming** (`/api/events`) pushes logs and status updates to the frontend in real time
- **Playwright runner** spawns `npx playwright test` as a child process, parses list-reporter output, and streams results
- **SUT API** (`/api/sut`) handles EV plugin/plugout/reset commands called by OCTT during tests
- **Config persistence** saves UI settings to `dashboard-config.json` and merges them with environment variables
- **Reboot timeout management** automatically applies extended timeouts (600s) when reboot tests are detected

### 2. OCTT Client (`connectors/octt/`)

- **`OcttClient`** — High-level wrapper for all OCTT REST endpoints (configurations, sessions, test execution, reports, comments)
- **`HttpClient`** — Axios-based HTTP client that translates network errors into structured `OcttApiError` objects
- **Versioned paths** — All API calls are prefixed with `/{ocppVersion}/{role}` (e.g., `/ocpp1.6/CS`)

### 3. CDS Client (`connectors/cds/`)

- **`CdsClient`** — Raw TCP/SLEP protocol implementation for the Keysight SL1040A
- **Reactive status polling** — Uses RxJS to poll the `Status` PID every second and expose a `BehaviorSubject<number>`
- **Frame encoding/decoding** — Implements the full SLEP binary protocol (single PID GET/SET, multi-PID SET)
- **High-level operations** — `reset()`, `start()`, `stop()`, `configureCds()`, `configureEv()`, `readMeasurements()`

### 4. Orchestrator (`orchestrator/coordinator.ts`)

The `Orchestrator` class manages the complete pipeline lifecycle:

- **`prepareLab()`** — Connect CDS, check SUT status, reset and configure hardware
- **`executeTests()`** — Start OCTT session, run each test case sequentially, collect `ReportEntry[]`
- **`processResults()`** — Filter failures, deduplicate against Jira, create/comment/reopen issues, generate summary
- **`cleanup()`** — Stop CDS simulation, disconnect TCP, stop OCTT session

### 5. Domain Logic (`domain/`)

- **`dedup-engine.ts`** — Generates fingerprints from `testCaseName + verdict + category` and decides whether to create, comment, or reopen a Jira issue
- **`severity-classifier.ts`** — Multi-factor scoring (certification impact, verdict type, functional block, repeatability) mapped to Jira priorities
- **`jira-mapper.ts`** — Converts `ReportEntry` into Jira `CreateIssueInput` with ADF descriptions and labels
- **`execution-summarizer.ts`** — Aggregates results into pass/fail/inconc/error counts, identifies certification blockers, and formats markdown reports

### 6. Playwright Test Suite (`tests/certification_pipeline.spec.ts`)

The E2E test suite that runs outside the orchestrator:

- **Phase 0 (Lab Setup)** — Registers CDS instance, configures ISO 15118 DC profile, sets EV parameters (900V/300A/50kW)
- **Phase 1 (OCTT Session)** — Starts the OCTT session for the selected configuration
- **Phase 2 (Execution)** — Iterates over all functional suites and executes each test case via REST API with automatic CDS reset between charging-related tests
- **Phase 3 (Tear Down)** — Prints certification summary, stops OCTT session, cleans up CDS

**Fallback session start**: Each test case checks `sessionStarted` and starts the session itself if needed. This allows running individual tests with `--grep` without requiring the full suite.

---

## Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `OCTT_BASE_URL` | OCTT instance URL | *(empty)* |
| `OCTT_TOKEN` | OCTT API bearer token | *(empty)* |
| `OCTT_OCPP_VERSION` | OCPP version (`ocpp1.6` or `ocpp2.0.1`) | `ocpp1.6` |
| `OCTT_ROLE` | Role under test (`CS` or `CSMS`) | `CS` |
| `OCTT_CONFIG` | Default configuration name | `AUT_SID_SAT` |
| `CDS_IP` | Keysight CDS IP address | `192.168.100.10` |
| `CDS_PORT` | CDS SLEP TCP port | `51001` |
| `JIRA_BASE_URL` | Jira Cloud base URL | *(empty)* |
| `JIRA_EMAIL` | Atlassian account email | *(empty)* |
| `JIRA_API_TOKEN` | Jira API token | *(empty)* |
| `JIRA_PROJECT_KEY` | Jira project key | `CERT` |
| `CERT_DASHBOARD_PORT` | Dashboard server port | `3101` |

---

## Development Notes

- **TypeScript** is configured with strict mode. All source files use ES modules (`"type": "module"`).
- **RxJS** is used in the CDS client for reactive status polling and timeout handling.
- **Playwright** tests run in `serial` mode because OCTT does not support concurrent sessions.
- **Timeouts**: Normal tests use 70s/450s OCTT timeouts. Reboot tests automatically switch to 600s/650s before execution and restore defaults afterward.
- The **SUT API relay agent** (`sut-api-relay-agent/`) is a Python script that forwards OCTT SUT callbacks to the dashboard when direct network access is not possible.

---

## License

Private / Internal Use
