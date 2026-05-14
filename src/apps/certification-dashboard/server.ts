// ══════════════════════════════════════════════════════════════
// Certification Dashboard — Backend Server
// ══════════════════════════════════════════════════════════════
//
// REST API + SSE streaming for real-time pipeline monitoring.
// This is the central backend that orchestrates communication between:
//   - OCTT (OCPP Compliance Testing Tool) via REST API
//   - Keysight CDS (Charging Discovery System) via TCP/SLEP
//   - Jira Cloud for issue tracking
//   - The web frontend via Server-Sent Events (SSE)
//
// Architecture:
//   ┌──────────────┐  HTTP/SSE  ┌─────────────────────┐  REST    ┌──────┐
//   │   Browser    │◄──────────►│  Dashboard Server   │◄────────►│ OCTT │
//   └──────────────┘            │    (this file)      │          └──────┘
//                               │                     │  TCP     ┌──────┐
//                               │                     │◄────────►│ CDS  │
//                               │                     │          └──────┘
//                               │                     │  REST    ┌──────┐
//                               │                     │◄────────►│ Jira │
//                               └─────────────────────┘          └──────┘
// ══════════════════════════════════════════════════════════════

import express, { type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import { CdsClient, Specification, ChargeMode, type CdsConfig, type EvConfig, PidList } from "../../connectors/cds/index.js";
import { OcttClient } from "../../connectors/octt/index.js";
import type { ReportEntry } from "../../connectors/octt/types.js";
import { Orchestrator } from "../../orchestrator/coordinator.js";

// Resolve __dirname for ES modules (needed for serving static files)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Express Application Setup ──

const app = express();
app.use(cors());
app.use(express.json());

/** Port the dashboard server listens on (defaults to 3101) */
const PORT = parseInt(process.env.CERT_DASHBOARD_PORT ?? "3101", 10);

// ══════════════════════════════════════════════════════════════
// SECTION: SSE Infrastructure
// Server-Sent Events provide real-time log and status updates
// to the frontend without polling.
// ══════════════════════════════════════════════════════════════

/**
 * Represents a single connected SSE client.
 * Each browser tab that opens the dashboard gets its own client ID.
 */
interface SseClient {
    /** Unique incremental ID assigned to this connection */
    id: number;
    /** Express Response object used to stream events */
    res: Response;
}

/** Monotonically increasing counter for assigning unique SSE client IDs */
let sseIdCounter = 0;

/** Active SSE clients keyed by their client ID */
const sseClients = new Map<number, SseClient>();

/** In-memory ring buffer of recent log entries (last 1000 lines).
 *  This ensures logs are available via REST even when no Orchestrator is active
 *  (e.g., during Playwright-only runs). */
const logBuffer: Array<{ timestamp: string; level: string; message: string; service: string }> = [];
const MAX_LOG_BUFFER = 1000;

/**
 * Broadcasts an event to all connected SSE clients.
 * This is the primary mechanism for pushing real-time updates
 * (logs, status changes, pipeline progress) to the frontend.
 *
 * @param event - The SSE event name (e.g., "log", "status", "pipeline")
 * @param data  - Serializable payload to send
 */
function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [, client] of sseClients) {
        client.res.write(payload);
    }
}

/**
 * Logs a message to the console and broadcasts it to all SSE clients.
 * This ensures both the server console and the dashboard UI stay in sync.
 *
 * @param level   - Log severity (info, warn, error, success)
 * @param message - Human-readable log message
 * @param service - Originating service/component name (default: "dashboard")
 */
function log(level: string, message: string, service?: string) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        service: service ?? "dashboard",
    };
    console.log(`[${entry.timestamp}] [${entry.service}] ${message}`);
    broadcast("log", entry);
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
}

// ══════════════════════════════════════════════════════════════
// SECTION: Service State Management
// Tracks the connection status of external systems (CDS, OCTT, Jira)
// and notifies the frontend whenever a service transitions.
// ══════════════════════════════════════════════════════════════

/**
 * Connection state of an external service integrated into the dashboard.
 */
interface ServiceState {
    /** Current lifecycle status of the service connection */
    status: "disconnected" | "connecting" | "connected" | "running" | "error";
    /** Human-readable display label for the service */
    label: string;
    /** Detailed status text shown in the UI (e.g., IP address, error message) */
    info: string;
}

/** Map of service identifiers to their current state */
const services = new Map<string, ServiceState>([
    ["cds",  { status: "disconnected", label: "CDS",  info: "Keysight SL1040A" }],
    ["octt", { status: "disconnected", label: "OCTT", info: "Compliance Testing Tool" }],
    ["jira", { status: "disconnected", label: "Jira", info: "Issue Tracking" }],
]);

/**
 * Updates the status of a service and broadcasts the change.
 *
 * @param service - Service key ("cds", "octt", or "jira")
 * @param status  - New status value
 * @param info    - Optional updated info text
 */
function setService(service: string, status: ServiceState["status"], info?: string) {
    const state = services.get(service)!;
    state.status = status;
    if (info) state.info = info;
    broadcast("status", { service, status, info: state.info });
}

// ══════════════════════════════════════════════════════════════
// SECTION: Environment-based Configuration Defaults
// These values are loaded from environment variables on startup.
// They can be overridden by the persisted dashboard-config.json
// via the UI settings panel.
// ══════════════════════════════════════════════════════════════

/** Default OCTT configuration loaded from environment variables */
const octtConfig = {
    baseUrl: process.env.OCTT_BASE_URL || "",
    token: process.env.OCTT_TOKEN || "",
    ocppVersion: process.env.OCTT_OCPP_VERSION ?? "ocpp1.6",
    role: (process.env.OCTT_ROLE ?? "CS") as "CS" | "CSMS",
};

/** Default CDS (Keysight SL1040A) IP address */
const cdsDefaultIp = process.env.CDS_IP || "192.168.100.10";

/** Default CDS TCP port (SLEP protocol) */
const cdsDefaultPort = parseInt(process.env.CDS_PORT ?? "51001", 10);

/** Default Jira Cloud configuration loaded from environment variables */
const jiraConfig = {
    baseUrl: process.env.JIRA_BASE_URL || "",
    email: process.env.JIRA_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    projectKey: process.env.JIRA_PROJECT_KEY ?? "CERT",
};

// ══════════════════════════════════════════════════════════════
// SECTION: Charge Profiles
// Pre-defined EV configurations for different charging standards.
// Each profile bundles the CDS specification, charge mode, and EV
// electrical parameters (voltage/current limits, battery capacity).
// ══════════════════════════════════════════════════════════════

/**
 * A charge profile defines the full EV+CDS configuration for a
 * specific certification scenario (e.g., CCS 900V DC fast charging).
 */
interface ChargeProfile {
    /** Human-readable label shown in the UI */
    label: string;
    /** Charging protocol specification (ISO 15118, DIN 70121, etc.) */
    specification: Specification;
    /** CDS hardware configuration (spec, mode, sink) */
    cdsConfig: CdsConfig;
    /** EV electrical parameters sent to the CDS simulator */
    evConfig: EvConfig;
}

/**
 * Pre-configured charge profiles covering the most common certification
 * scenarios. Keys are used as URL-safe identifiers.
 */
const chargeProfiles: Record<string, ChargeProfile> = {
    "CCS_900V_300A": {
        label: "CCS 900V / 300A / 50kW",
        specification: Specification.ISO_15118,
        cdsConfig: { specification: Specification.ISO_15118, chargeMode: ChargeMode.DC, sinkId: 12 },
        evConfig: { EVMaximumVoltageLimit: 900, EVMinimumVoltageLimit: 800, EVMaximumCurrentLimit: 300, EVMinimumCurrentLimit: 0, EVMaximumPowerLimit: 50000, BatteryCapacity: 50000, EVstateOfCharge: 20 },
    },
    "CCS_500V_125A": {
        label: "CCS 500V / 125A / 25kW",
        specification: Specification.ISO_15118,
        cdsConfig: { specification: Specification.ISO_15118, chargeMode: ChargeMode.DC, sinkId: 12 },
        evConfig: { EVMaximumVoltageLimit: 500, EVMinimumVoltageLimit: 300, EVMaximumCurrentLimit: 125, EVMinimumCurrentLimit: 0, EVMaximumPowerLimit: 25000, BatteryCapacity: 25000, EVstateOfCharge: 20 },
    },
    "CCS_1000V_400A": {
        label: "CCS 1000V / 400A / 150kW",
        specification: Specification.ISO_15118_20,
        cdsConfig: { specification: Specification.ISO_15118_20, chargeMode: ChargeMode.DC, sinkId: 12 },
        evConfig: { EVMaximumVoltageLimit: 1000, EVMinimumVoltageLimit: 800, EVMaximumCurrentLimit: 400, EVMinimumCurrentLimit: 0, EVMaximumPowerLimit: 150000, BatteryCapacity: 100000, EVstateOfCharge: 10 },
    },
    "CCS_DIN_500V_125A": {
        label: "CCS DIN 70121 500V / 125A / 50kW",
        specification: Specification.DIN_SPEC_70121,
        cdsConfig: { specification: Specification.DIN_SPEC_70121, chargeMode: ChargeMode.DC, sinkId: 12 },
        evConfig: { EVMaximumVoltageLimit: 500, EVMinimumVoltageLimit: 300, EVMaximumCurrentLimit: 125, EVMinimumCurrentLimit: 0, EVMaximumPowerLimit: 50000, BatteryCapacity: 25000, EVstateOfCharge: 20 },
    },
};

// ══════════════════════════════════════════════════════════════
// SECTION: Pipeline State
// Shared mutable state tracking the current test run.
// ══════════════════════════════════════════════════════════════

/** Active orchestrator instance while a pipeline is running */
let orchestrator: Orchestrator | null = null;

/** True when the orchestrator pipeline is currently executing */
let pipelineRunning = false;

/** Results collected from the most recent pipeline execution */
let pipelineResults: ReportEntry[] = [];

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — Status & Information Endpoints
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/status
 * Returns the current connection status of all services, pipeline state,
 * available charge profiles, and active configuration (with masked token).
 */
app.get("/api/status", (_req: Request, res: Response) => {
    res.json({
        services: Object.fromEntries(services),
        pipeline: {
            running: pipelineRunning,
            resultsCount: pipelineResults.length,
        },
        profiles: Object.keys(chargeProfiles),
        config: {
            octtUrl: effectiveOcttConfig.baseUrl,
            octtToken: effectiveOcttConfig.token ? effectiveOcttConfig.token.slice(0, 8) + "..." : "",
            cdsIp: effectiveCdsIp,
            cdsPort: effectiveCdsPort,
            sinkId: 12,
            ocppVersion: effectiveOcttConfig.ocppVersion,
            role: effectiveOcttConfig.role,
            jiraProjectKey: effectiveJiraConfig.projectKey,
        },
    });
});

/**
 * GET /api/profiles
 * Lists all available charge profiles with their key, label, spec name, and EV config.
 */
app.get("/api/profiles", (_req: Request, res: Response) => {
    const profiles = Object.entries(chargeProfiles).map(([key, profile]) => ({
        name: key,
        label: profile.label,
        spec: Specification[profile.specification],
        evConfig: profile.evConfig,
    }));
    res.json(profiles);
});

/**
 * GET /api/results
 * Returns the results of the most recent pipeline run, including
 * aggregated pass/fail/inconc/error counts and pass rate percentage.
 */
app.get("/api/results", (_req: Request, res: Response) => {
    const results = pipelineResults.map((report) => ({
        testCase: report.testCaseName,
        verdict: report.verdict.toLowerCase(),
        duration: report.duration,
        configuration: report.configuration,
        category: report.category,
        description: report.description,
        logfile: report.logfile,
    }));
    const passCount = results.filter((r) => r.verdict === "pass").length;
    const failCount = results.filter((r) => r.verdict === "fail").length;
    const inconcCount = results.filter((r) => r.verdict === "inconc").length;
    const errorCount = results.filter((r) => r.verdict === "error").length;
    res.json({
        results,
        total: results.length,
        passed: passCount,
        failed: failCount,
        inconc: inconcCount,
        error: errorCount,
        passRate: results.length > 0 ? Math.round((passCount / results.length) * 100) : 0,
    });
});

/**
 * GET /api/logs
 * Returns the dashboard's in-memory log buffer.
 * This captures logs from both Orchestrator-based pipelines and
 * Playwright-based test runs, ensuring logs are always available.
 */
app.get("/api/logs", (_req: Request, res: Response) => {
    res.json(logBuffer);
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — CDS Actions
// Endpoints for connecting to and configuring the Keysight CDS.
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/cds/connect
 * Attempts a TCP connection to the CDS at the given (or default) IP/port.
 * Returns connection success/failure and updates the CDS service status.
 */
app.post("/api/cds/connect", async (req: Request, res: Response) => {
    const { ip, port } = req.body;
    setService("cds", "connecting", `${ip ?? effectiveCdsIp}:${port ?? effectiveCdsPort}`);
    try {
        const cds = new CdsClient(ip ?? effectiveCdsIp, port ?? effectiveCdsPort);
        const ok = await cds.connect();
        if (ok) {
            setService("cds", "connected", `${cds.ip}:${cds.port}`);
            res.json({ ok: true, ip: cds.ip, port: cds.port });
        } else {
            setService("cds", "error", "Connection failed");
            res.json({ ok: false, error: "Connection failed" });
        }
    } catch (error) {
        setService("cds", "error", String(error));
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/cds/configure
 * Configures the CDS with a selected charge profile (spec, mode, sink)
 * and EV parameters, then resets and disconnects. This prepares the
 * hardware for a certification test run.
 */
app.post("/api/cds/configure", async (req: Request, res: Response) => {
    const { ip, port, profile } = req.body;
    const selectedProfile = chargeProfiles[profile ?? "CCS_900V_300A"] ?? chargeProfiles["CCS_900V_300A"]!;
    const cds = new CdsClient(ip ?? effectiveCdsIp, port ?? effectiveCdsPort);
    log("info", `Configuring CDS: ${selectedProfile.label}`, "cds");
    try {
        await cds.connect();
        await cds.reset();
        await cds.configureCds(selectedProfile.cdsConfig);
        await cds.configureEv(selectedProfile.evConfig);
        await cds.disconnect();
        setService("cds", "connected", `${cds.ip}:${cds.port} — ${selectedProfile.label}`);
        log("info", "CDS configuration complete", "cds");
        res.json({ ok: true, profile: selectedProfile.label });
    } catch (error) {
        setService("cds", "error", String(error));
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/cds/check
 * Performs a lightweight health check on the CDS: connects, reads the
 * current status bitmask, translates it to human-readable flags, and disconnects.
 */
app.post("/api/cds/check", async (req: Request, res: Response) => {
    const { ip, port } = req.body;
    const cds = new CdsClient(ip ?? effectiveCdsIp, port ?? effectiveCdsPort);
    try {
        const ok = await cds.connect();
        if (ok) {
            const status = cds.statusValue.getValue();
            const flags = cds.getStatusDescription(status);
            await cds.disconnect();
            setService("cds", "connected", `Status: ${flags.join(", ")}`);
            res.json({ ok: true, status, flags });
        } else {
            setService("cds", "error", "No response");
            res.json({ ok: false, error: "No response" });
        }
    } catch (error) {
        setService("cds", "error", String(error));
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * GET /api/cds/measurements
 * Reads live DC measurements from the CDS: voltage, current, SoC, and CP state.
 * Used by the frontend real-time chart modal.
 */
app.get("/api/cds/measurements", async (_req: Request, res: Response) => {
    const cds = new CdsClient(effectiveCdsIp, effectiveCdsPort);
    try {
        const ok = await cds.connect();
        if (!ok) {
            return res.status(503).json({ ok: false, error: "CDS not responding" });
        }
        const measurements = await cds.readMeasurements();
        const status = cds.statusValue.getValue();
        const flags = cds.getStatusDescription(status);
        await cds.disconnect();
        res.json({
            ok: true,
            timestamp: new Date().toISOString(),
            ...measurements,
            statusFlags: flags,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const isTimeout = errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT") || errMsg.includes("ECONNREFUSED");
        const friendly = isTimeout
            ? `CDS timeout (${effectiveCdsIp}:${effectiveCdsPort}). Check: 1) CDS is powered on, 2) Network/VPN connected, 3) IP and port are correct.`
            : errMsg;
        res.status(500).json({ ok: false, error: friendly, code: isTimeout ? "TIMEOUT" : "ERROR" });
    }
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — OCTT Actions
// Endpoints for interacting with the OCTT API.
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/octt/check
 * Validates OCTT connectivity by listing available configurations.
 * Accepts optional override URL/token in the request body.
 */
app.post("/api/octt/check", async (req: Request, res: Response) => {
    const { baseUrl, token } = req.body;
    setService("octt", "connecting");
    try {
        const cfg = {
            ...effectiveOcttConfig,
            ...(baseUrl && baseUrl.trim() ? { baseUrl } : {}),
            ...(token && token.trim() ? { token } : {}),
        };
        const octt = new OcttClient(cfg);
        const result = await octt.listConfigurations();
        setService("octt", "connected", `${result.configurations.length} configs`);
        res.json({ ok: true, configurations: result.configurations });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const isTimeout = errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT") || errMsg.includes("ECONNREFUSED");
        const friendly = isTimeout
            ? `CDS timeout (${effectiveCdsIp}:${effectiveCdsPort}). Check: 1) CDS is powered on, 2) Network/VPN connected, 3) IP and port are correct.`
            : errMsg;
        setService("cds", "error", friendly);
        res.status(500).json({ ok: false, error: friendly, code: isTimeout ? "TIMEOUT" : "ERROR" });
    }
});

/**
 * POST /api/octt/testcases
 * Lists all test cases available for a given OCTT configuration name.
 */
app.post("/api/octt/testcases", async (req: Request, res: Response) => {
    const { configurationName } = req.body;
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const result = await octt.listTestCases(configurationName);
        const testcases = result.data.testcasesData.flatMap((group) => group.data);
        res.json({ ok: true, testcases });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/octt/check-config
 * Verifies whether a specific configuration name exists on the OCTT server,
 * and returns its session status and test case count.
 */
app.post("/api/octt/check-config", async (req: Request, res: Response) => {
    const { configurationName } = req.body;
    const cfg = { ...effectiveOcttConfig, ...(req.body.baseUrl ? { baseUrl: req.body.baseUrl } : {}), ...(req.body.token ? { token: req.body.token } : {}) };
    try {
        const octt = new OcttClient(cfg);
        const configs = await octt.listConfigurations();
        const exists = configs.configurations.includes(configurationName);
        let sessionStatus = "unknown";
        let testcases: unknown[] = [];
        if (exists) {
            try {
                const sut = await octt.getSutStatus();
                sessionStatus = sut.sessionStatus;
            } catch { sessionStatus = "no session"; }
            try {
                const tc = await octt.listTestCases(configurationName);
                testcases = tc.data.testcasesData.flatMap((group) => group.data);
            } catch { /* ignore: test case listing is optional for this check */ }
        }
        res.json({ ok: true, url: cfg.baseUrl, exists, configurations: configs.configurations, sessionStatus, testcasesCount: testcases.length });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error), url: cfg.baseUrl });
    }
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — Config Timeouts
// OCTT configurations include timeout parameters that control how
// long the test tool waits for SUT responses. These endpoints allow
// reading and updating those values.
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/octt/config-timeouts
 * Reads the timeout parameters (maxTimeoutPeriod, longOperationTimeout,
 * maxTimeDeviation) from the specified OCTT configuration.
 */
app.get("/api/octt/config-timeouts", async (req: Request, res: Response) => {
    const { configurationName } = req.query;
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const config = await octt.getConfiguration(String(configurationName || "AUT_SID_SAT"));
        const timeouts = {
            maxTimeoutPeriod: config.data.config.max_timeout_period,
            longOperationTimeout: config.data.config.long_operation_timeout,
            maxTimeDeviation: config.data.config.max_time_deviation,
        };
        res.json({ ok: true, timeouts });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/octt/config-timeouts
 * Updates timeout parameters in the specified OCTT configuration.
 * Only provided fields are modified; omitted fields keep their current value.
 */
app.post("/api/octt/config-timeouts", async (req: Request, res: Response) => {
    const { configurationName, maxTimeoutPeriod, longOperationTimeout, maxTimeDeviation } = req.body;
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const current = await octt.getConfiguration(configurationName || "AUT_SID_SAT");
        const updatedConfig: Record<string, unknown> = { ...current.data.config };

        if (maxTimeoutPeriod !== undefined) updatedConfig.max_timeout_period = String(maxTimeoutPeriod);
        if (longOperationTimeout !== undefined) updatedConfig.long_operation_timeout = String(longOperationTimeout);
        if (maxTimeDeviation !== undefined) updatedConfig.max_time_deviation = String(maxTimeDeviation);

        await octt.saveConfiguration(configurationName || "AUT_SID_SAT", updatedConfig);
        log("info", `Timeouts updated for ${configurationName || "AUT_SID_SAT"}`, "octt");
        res.json({ ok: true, message: "Timeouts updated" });
    } catch (error) {
        log("error", `Failed to update timeouts: ${error}`, "octt");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — Reboot Test Helpers
// Reboot tests (cold boot, hard/soft reset, power failure) require
// extended timeout values because the charge point may take several
// minutes to reconnect after a reboot.
//
// REBOOT_TIMEOUTS:  600s / 650s — enough time for CP to boot + TLS
// DEFAULT_TIMEOUTS:  70s / 450s — standard values for normal tests
// ══════════════════════════════════════════════════════════════

/** Extended timeouts for reboot-related test cases (seconds) */
const REBOOT_TIMEOUTS = {
    maxTimeoutPeriod: "600",
    longOperationTimeout: "650",
    maxTimeDeviation: "4",
};

/** Standard timeout values for non-reboot test cases (seconds) */
const DEFAULT_TIMEOUTS = {
    maxTimeoutPeriod: "70",
    longOperationTimeout: "450",
    maxTimeDeviation: "4",
};

/**
 * POST /api/octt/prepare-reboot
 * Applies extended reboot timeouts to the OCTT configuration.
 * Must be called *before* running any reboot test cases.
 */
app.post("/api/octt/prepare-reboot", async (req: Request, res: Response) => {
    const { configurationName } = req.body;
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const current = await octt.getConfiguration(configurationName || "AUT_SID_SAT");
        const updatedConfig: Record<string, unknown> = { ...current.data.config };

        updatedConfig.max_timeout_period = REBOOT_TIMEOUTS.maxTimeoutPeriod;
        updatedConfig.long_operation_timeout = REBOOT_TIMEOUTS.longOperationTimeout;
        updatedConfig.max_time_deviation = REBOOT_TIMEOUTS.maxTimeDeviation;

        await octt.saveConfiguration(configurationName || "AUT_SID_SAT", updatedConfig);
        log("info", `Reboot timeouts applied to ${configurationName || "AUT_SID_SAT"}`, "octt");
        res.json({ ok: true, message: "Reboot timeouts applied", timeouts: REBOOT_TIMEOUTS });
    } catch (error) {
        log("error", `Failed to apply reboot timeouts: ${error}`, "octt");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/octt/restore-defaults
 * Restores the default (non-reboot) timeout values to the OCTT configuration.
 * Should be called after reboot tests are complete.
 */
app.post("/api/octt/restore-defaults", async (req: Request, res: Response) => {
    const { configurationName } = req.body;
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const current = await octt.getConfiguration(configurationName || "AUT_SID_SAT");
        const updatedConfig: Record<string, unknown> = { ...current.data.config };

        updatedConfig.max_timeout_period = DEFAULT_TIMEOUTS.maxTimeoutPeriod;
        updatedConfig.long_operation_timeout = DEFAULT_TIMEOUTS.longOperationTimeout;
        updatedConfig.max_time_deviation = DEFAULT_TIMEOUTS.maxTimeDeviation;

        await octt.saveConfiguration(configurationName || "AUT_SID_SAT", updatedConfig);
        log("info", `Default timeouts restored for ${configurationName || "AUT_SID_SAT"}`, "octt");
        res.json({ ok: true, message: "Default timeouts restored", timeouts: DEFAULT_TIMEOUTS });
    } catch (error) {
        log("error", `Failed to restore default timeouts: ${error}`, "octt");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

// ══════════════════════════════════════════════════════════════
// SECTION: Static Test Case Catalog
// This catalog mirrors the test suites defined in the Playwright
// test file (tests/certification_pipeline.spec.ts). Keeping it
// server-side allows the frontend to display test selectors
// without running Playwright.
// ══════════════════════════════════════════════════════════════

/** Test suites mapped to their constituent test case IDs */
const testSuites: Record<string, string[]> = {
    "MAINTENANCE": ["tc_bi_restore_configuration", "tc_bi_stop_transactions", "tc_bi_clear_cache", "tc_bi_clear_local_auth_list", "tc_bi_restore_availability", "tc_bi_reset_hard"],
    "Authorization": ["TC_023_4_CS", "TC_023_5_CS", "TC_024_CS", "TC_061_1_CS", "TC_061_2_CS"],
    "DataTransfer": ["TC_062_CS"],
    "FirmwareManagement": ["TC_044_1_CS", "TC_044_2_CS", "TC_044_3_CS", "TC_045_1_CS", "TC_045_2_CS"],
    "LocalAuthList": ["TC_008_1_CS", "TC_008_2_CS", "TC_042_1_CS", "TC_042_2_CS", "TC_043_1_CS", "TC_043_2_CS", "TC_043_3_CS", "TC_043_CS"],
    "MeterValues": ["TC_070_CS", "TC_071_CS"],
    "Provisioning": ["TC_001_CS", "TC_002_CS", "TC_013_CS", "TC_014_CS", "TC_015_CS", "TC_016_CS", "TC_019_CS", "TC_021_CS", "TC_032_1_CS", "TC_032_2_CS", "TC_034_CS", "TC_040_1_CS", "TC_040_2_CS", "TC_041_CS"],
    "RemoteControl": ["TC_010_CS", "TC_011_1_CS", "TC_011_2_CS", "TC_012_CS", "TC_017_1_CS", "TC_017_2_CS", "TC_018_1_CS", "TC_018_2_CS", "TC_026_CS", "TC_027_CS", "TC_028_CS", "TC_030_CS", "TC_031_CS"],
    "RemoteTrigger": ["TC_054_CS", "TC_055_CS"],
    "Reservation": ["TC_046_1_CS", "TC_046_2_CS", "TC_047_CS", "TC_048_1_CS", "TC_048_2_CS", "TC_048_3_CS", "TC_048_4_CS", "TC_049_CS", "TC_050_1_CS", "TC_050_2_CS", "TC_050_3_CS", "TC_050_4_CS", "TC_051_CS", "TC_052_CS", "TC_053_1_CS", "TC_053_2_CS"],
    "Security": ["TC_073_CS", "TC_074_CS", "TC_075_1_CS", "TC_075_2_CS", "TC_076_CS", "TC_077_CS", "TC_078_CS", "TC_079_CS", "TC_080_CS", "TC_081_CS", "TC_083_CS", "TC_084_CS", "TC_085_CS", "TC_086_CS", "TC_087_CS"],
    "SmartCharging": ["TC_056_CS", "TC_057_CS", "TC_058_1_CS", "TC_058_2_CS", "TC_059_CS", "TC_060_CS", "TC_066_CS", "TC_067_CS", "TC_072_CS", "TC_082_CS"],
    "Transactions": ["TC_003_CS", "TC_004_1_CS", "TC_004_2_CS", "TC_005_1_CS", "TC_005_2_CS", "TC_005_3_CS", "TC_007_1_CS", "TC_007_2_CS", "TC_036_CS", "TC_037_1_CS", "TC_037_2_CS", "TC_037_3_CS", "TC_038_CS", "TC_039_CS", "TC_068_CS", "TC_069_CS"],
};

/**
 * Test case IDs that involve rebooting the charge point.
 * When these are selected for Playwright execution, the server
 * automatically applies REBOOT_TIMEOUTS before starting.
 */
const REBOOT_TESTS = ["TC_001_CS", "TC_002_CS", "TC_013_CS", "TC_014_CS", "TC_015_CS", "TC_016_CS", "TC_032_1_CS", "TC_032_2_CS", "TC_034_CS"];

/**
 * GET /api/testcases
 * Returns the full test suite catalog as a JSON object.
 */
app.get("/api/testcases", (_req: Request, res: Response) => {
    res.json(testSuites);
});

/** Human-readable descriptions for each test case ID */
const testDescriptions: Record<string, string> = {
    "TC_023_4_CS": "Start local Charging Session - Authorize invalid",
    "TC_023_5_CS": "Start remote Charging Session - Authorize invalid",
    "TC_024_CS": "Start Charging Session - Lock Failure",
    "TC_061_1_CS": "Clear Authorization Data in Authorization Cache - Local",
    "TC_061_2_CS": "Clear Authorization Data in Authorization Cache - Remote",
    "TC_062_CS": "Data Transfer to a Charge Point",
    "TC_044_1_CS": "Firmware Update - Download and Install",
    "TC_044_2_CS": "Firmware Update - Download Failed",
    "TC_044_3_CS": "Firmware Update - Installation Failed",
    "TC_045_1_CS": "Get Diagnostics",
    "TC_045_2_CS": "Get Diagnostics - Upload Failed",
    "TC_008_1_CS": "Regular Start Charging Session - Id in Local Authorization List",
    "TC_008_2_CS": "Remote Start Charging Session - Id in Local Authorization List",
    "TC_042_1_CS": "Get Local List Version (not supported)",
    "TC_042_2_CS": "Get Local List Version (empty)",
    "TC_043_1_CS": "Send Local Authorization List - NotSupported",
    "TC_043_2_CS": "Send Local Authorization List - VersionMismatch",
    "TC_043_3_CS": "Send Local Authorization List - Failed",
    "TC_043_CS": "Send Local Authorization List",
    "TC_070_CS": "Sampled Meter Values",
    "TC_071_CS": "Clock-aligned Meter Values",
    "TC_001_CS": "Cold Boot Charge Point",
    "TC_002_CS": "Cold Boot Charge Point - Pending",
    "TC_013_CS": "Hard Reset Without transaction",
    "TC_014_CS": "Soft Reset Without Transaction",
    "TC_015_CS": "Hard Reset With Transaction",
    "TC_016_CS": "Soft Reset With Transaction",
    "TC_019_CS": "Retrieve configuration",
    "TC_021_CS": "Change/set Configuration",
    "TC_032_1_CS": "Power failure boot charging point - stop transactions before going down",
    "TC_032_2_CS": "Power failure boot charging point - stop transactions",
    "TC_034_CS": "Power Failure with Unavailable Status",
    "TC_040_1_CS": "Configuration key - NotSupported",
    "TC_040_2_CS": "Configuration key - Invalid value",
    "TC_041_CS": "Fault Behavior",
    "TC_010_CS": "Remote Start Charging Session - Cable Plugged in First",
    "TC_011_1_CS": "Remote Start Charging Session - Remote Start First",
    "TC_011_2_CS": "Remote Start Charging Session - Time Out",
    "TC_012_CS": "Remote Stop Charging Session",
    "TC_017_1_CS": "Unlock connector - no charging session (Not fixed cable)",
    "TC_017_2_CS": "Unlock connector - no charging session (Fixed cable)",
    "TC_018_1_CS": "Unlock Connector - With Charging Session (Not fixed cable)",
    "TC_018_2_CS": "Unlock Connector - With Charging Session (Fixed cable)",
    "TC_026_CS": "Remote Start Charging Session - Rejected",
    "TC_027_CS": "Remote start transaction - connector id shall not be 0",
    "TC_028_CS": "Remote Stop Transaction - Rejected",
    "TC_030_CS": "Unlock Connector - Unlock Failure",
    "TC_031_CS": "Unlock Connector - Unknown Connector",
    "TC_054_CS": "Trigger Message",
    "TC_055_CS": "Trigger Message - Rejected",
    "TC_046_1_CS": "Reservation of a Connector - Local start transaction",
    "TC_046_2_CS": "Reservation of a Connector - Remote start transaction",
    "TC_047_CS": "Reservation of a Connector - Expire",
    "TC_048_1_CS": "Reservation of a Connector - Faulted",
    "TC_048_2_CS": "Reservation of a Connector - Occupied",
    "TC_048_3_CS": "Reservation of a Connector - Unavailable",
    "TC_048_4_CS": "Reservation of a Connector - Rejected",
    "TC_049_CS": "Reservation of a Charge Point - Transaction",
    "TC_050_1_CS": "Reservation of a Charge Point - Faulted",
    "TC_050_2_CS": "Reservation of a Charge Point - Occupied",
    "TC_050_3_CS": "Reservation of a Charge Point - Unavailable",
    "TC_050_4_CS": "Reservation of a Charge Point - Rejected",
    "TC_051_CS": "Cancel Reservation",
    "TC_052_CS": "Cancel Reservation - Rejected",
    "TC_053_1_CS": "Use a reserved Connector with parentIdTag - Local",
    "TC_053_2_CS": "Use a reserved Connector with parentIdTag - Remote",
    "TC_073_CS": "Update Charge Point Password for HTTP Basic Authentication",
    "TC_074_CS": "Update Charge Point Certificate by request of Central System",
    "TC_075_1_CS": "Install a certificate on the Charge Point - ManufacturerRootCertificate",
    "TC_075_2_CS": "Install a certificate on the Charge Point - CentralSystemRootCertificate",
    "TC_076_CS": "Delete a specific certificate from the Charge Point",
    "TC_077_CS": "Invalid ChargePointCertificate Security Event",
    "TC_078_CS": "Invalid CentralSystemCertificate Security Event",
    "TC_079_CS": "Get Security Log",
    "TC_080_CS": "Secure Firmware Update",
    "TC_081_CS": "Secure Firmware Update - Invalid Signature",
    "TC_083_CS": "Upgrade security profile",
    "TC_084_CS": "Downgrade security profile - Rejected",
    "TC_085_CS": "Basic Authentication - Valid username/password combination",
    "TC_086_CS": "TLS - server-side certificate - Valid certificate",
    "TC_087_CS": "TLS - Client-side certificate - valid certificate",
    "TC_056_CS": "Central Smart Charging - TxDefaultProfile",
    "TC_057_CS": "Central Smart Charging - TxProfile",
    "TC_058_1_CS": "Central Smart Charging - No ongoing transaction",
    "TC_058_2_CS": "Central Smart Charging - Wrong transactionId",
    "TC_059_CS": "Remote Start Transaction with Charging Profile",
    "TC_060_CS": "Remote Start Transaction with Charging Profile - Rejected",
    "TC_066_CS": "Get Composite Schedule",
    "TC_067_CS": "Clear Charging Profile",
    "TC_072_CS": "Stacking Charging Profiles",
    "TC_082_CS": "Central Smart Charging - TxDefaultProfile - with ongoing transaction",
    "TC_003_CS": "Regular Charging Session - Plugin First",
    "TC_004_1_CS": "Regular Charging Session - Identification First",
    "TC_004_2_CS": "Regular Charging Session - Identification First - ConnectionTimeOut",
    "TC_005_1_CS": "EV Side Disconnected - StopTransactionOnEVSideDisconnect=true - UnlockConnector=true",
    "TC_005_2_CS": "EV Side Disconnected - StopTransactionOnEVSideDisconnect=true - UnlockConnector=false",
    "TC_005_3_CS": "EV Side Disconnected - StopTransactionOnEVSideDisconnect=false - UnlockConnector=false",
    "TC_007_1_CS": "Regular Start Charging Session - Cached Id",
    "TC_007_2_CS": "Remote Start Charging Session - Cached Id",
    "TC_036_CS": "Connection Loss During Transaction",
    "TC_037_1_CS": "Offline Start Transaction - Valid IdTag",
    "TC_037_2_CS": "Offline Start Transaction - Invalid IdTag - StopTransactionOnInvalidId=false",
    "TC_037_3_CS": "Offline Start Transaction - Invalid IdTag - StopTransactionOnInvalidId=true",
    "TC_038_CS": "Offline Stop Transaction",
    "TC_039_CS": "Offline Transaction",
    "TC_068_CS": "Stop transaction - IdTag in StopTransaction matches IdTag in StartTransaction",
    "TC_069_CS": "Stop transaction - ParentIdTag in StopTransaction matches ParentIdTag in StartTransaction",
};

/**
 * GET /api/testcases/details
 * Returns the static human-readable description map for all test cases.
 */
app.get("/api/testcases/details", (_req: Request, res: Response) => {
    res.json(testDescriptions);
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — Pipeline Control (Orchestrator)
// The orchestrator path runs tests through the TypeScript coordinator
// rather than spawning Playwright as a subprocess.
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/pipeline/start
 * Starts the full certification pipeline using the Orchestrator class:
 * 1. Prepares the lab (connect CDS, configure EV, check SUT)
 * 2. Executes the selected test cases via OCTT REST API
 * 3. Cleans up and broadcasts results via SSE.
 */
app.post("/api/pipeline/start", async (req: Request, res: Response) => {
    if (pipelineRunning) {
        return res.status(409).json({ ok: false, error: "Pipeline already running" });
    }

    const { profile, configurationName, testcaseNames, cdsIp, cdsPort } = req.body;
    const selectedProfile = chargeProfiles[profile ?? "CCS_900V_300A"] ?? chargeProfiles["CCS_900V_300A"]!;

    pipelineRunning = true;
    pipelineResults = [];
    broadcast("pipeline", { state: "starting", message: `Starting pipeline: ${selectedProfile.label}` });
    log("info", `Pipeline starting — profile: ${selectedProfile.label}, config: ${configurationName}`, "pipeline");

    setService("cds", "connecting");
    setService("octt", "connecting");

    orchestrator = new Orchestrator({
        octt: effectiveOcttConfig,
        cds: { ip: cdsIp ?? effectiveCdsIp, port: cdsPort ?? effectiveCdsPort },
        jira: effectiveJiraConfig,
        cdsConfig: selectedProfile.cdsConfig,
        evConfig: selectedProfile.evConfig,
    });

    res.json({ ok: true, message: "Pipeline started" });

    try {
        broadcast("pipeline", { state: "preparing", message: "Preparing lab..." });
        const labOk = await orchestrator.prepareLab();
        if (!labOk) {
            broadcast("pipeline", { state: "error", message: "Lab preparation failed" });
            log("error", "Lab preparation failed", "pipeline");
            setService("cds", "error", "Lab prep failed");
            pipelineRunning = false;
            return;
        }
        setService("cds", "running", selectedProfile.label);
        log("info", "Lab prepared", "pipeline");

        broadcast("pipeline", { state: "testing", message: "Executing tests..." });
        const results = await orchestrator.executeTests(configurationName, testcaseNames);
        pipelineResults = results;

        if (results.length > 0) {
            const passCount = results.filter((r) => r.verdict.toLowerCase() === "pass").length;
            setService("octt", "connected", `${passCount}/${results.length} passed`);
        }

        broadcast("pipeline", { state: "cleaning", message: "Cleaning up..." });
        await orchestrator.cleanup();
        setService("cds", "connected", "Stopped — idle");

        const passCount = results.filter((r) => r.verdict.toLowerCase() === "pass").length;
        broadcast("pipeline", {
            state: "done",
            message: `Complete: ${passCount}/${results.length} passed (${results.length > 0 ? Math.round((passCount / results.length) * 100) : 0}%)`,
            results: results.map((r) => ({ testCase: r.testCaseName, verdict: r.verdict, duration: r.duration })),
        });
        log("info", `Pipeline complete — ${passCount}/${results.length} passed`, "pipeline");
    } catch (error) {
        broadcast("pipeline", { state: "error", message: String(error) });
        log("error", String(error), "pipeline");
        try { await orchestrator?.cleanup(); } catch { /* ignore cleanup errors during failure */ }
    } finally {
        pipelineRunning = false;
    }
});

/**
 * POST /api/pipeline/stop
 * Stops a running orchestrator pipeline and performs cleanup.
 */
app.post("/api/pipeline/stop", async (_req: Request, res: Response) => {
    if (!pipelineRunning) {
        return res.status(409).json({ ok: false, error: "No pipeline running" });
    }
    if (orchestrator) {
        await orchestrator.cleanup();
    }
    pipelineRunning = false;
    broadcast("pipeline", { state: "cancelled", message: "Pipeline cancelled by user" });
    log("warn", "Pipeline cancelled", "pipeline");
    res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — Playwright Runner
// Spawns Playwright as a child process to execute the full
// certification test suite (tests/certification_pipeline.spec.ts).
// This is the preferred path for running many tests because
// Playwright handles retries, reporting, and test isolation.
// ══════════════════════════════════════════════════════════════

/** Handle to the currently running Playwright child process */
let playwrightProcess: ChildProcess | null = null;

/** True while Playwright is actively running tests */
let playwrightRunning = false;

/**
 * POST /api/pipeline/run-playwright
 * Spawns Playwright to run the certification_pipeline.spec.ts test file.
 *
 * Workflow:
 *  1. Detect if selected tests include reboot tests → apply extended timeouts
 *  2. Start an OCTT session for the selected configuration
 *  3. Spawn playwright test with optional --grep filter for selected tests
 *  4. Stream stdout/stderr logs back via SSE in real time
 *  5. Parse test verdicts (PASS/FAIL/INCONC/ERROR) from Playwright output
 *  6. On exit: stop OCTT session, restore default timeouts if needed,
 *     broadcast final results, and update the results table.
 *
 * @param req.body.testcaseNames     - Array of test case IDs to run (optional: runs all if empty)
 * @param req.body.configurationName - OCTT configuration name (default: AUT_SID_SAT)
 */
app.post("/api/pipeline/run-playwright", async (req: Request, res: Response) => {
    if (playwrightRunning) {
        return res.status(409).json({ ok: false, error: "Playwright already running" });
    }

    const { testcaseNames, configurationName } = req.body || {};
    const selectedTests = testcaseNames && testcaseNames.length > 0 ? testcaseNames : null;
    const configName = configurationName || "AUT_SID_SAT";

    // ── Step 1: Auto-detect reboot tests and apply extended timeouts ──
    // Reboot tests require the charge point to disconnect and reconnect,
    // which can take several minutes (boot + TLS handshake). The default
    // OCTT timeouts (70s) are too short, so we temporarily bump them to
    // 600s before starting.
    const hasRebootTests = selectedTests && selectedTests.some((testId: string) => REBOOT_TESTS.includes(testId));
    console.log(`[DEBUG] Selected tests: ${JSON.stringify(selectedTests)}`);
    console.log(`[DEBUG] REBOOT_TESTS: ${JSON.stringify(REBOOT_TESTS)}`);
    console.log(`[DEBUG] hasRebootTests: ${hasRebootTests}`);
    let rebootTimeoutsApplied = false;

    if (hasRebootTests) {
        log("info", "Reboot tests detected - applying extended timeouts", "playwright");
        broadcast("pipeline", { state: "starting", message: "Reboot tests detected - applying extended timeouts (600/650)..." });
        try {
            const octt = new OcttClient(effectiveOcttConfig);

            // OCTT requires the session to be stopped before saving config changes.
            // We attempt to stop any active session and wait briefly for it to settle.
            try {
                await octt.stopSession();
                log("info", "Stopped existing session to update config", "playwright");
                await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch {
                // No active session — safe to proceed
            }

            const current = await octt.getConfiguration(configName);
            const updatedConfig: Record<string, unknown> = { ...current.data.config };
            updatedConfig.max_timeout_period = REBOOT_TIMEOUTS.maxTimeoutPeriod;
            updatedConfig.long_operation_timeout = REBOOT_TIMEOUTS.longOperationTimeout;
            updatedConfig.max_time_deviation = REBOOT_TIMEOUTS.maxTimeDeviation;
            await octt.saveConfiguration(configName, updatedConfig);

            // Verify the config was actually saved (defensive check)
            const verify = await octt.getConfiguration(configName);
            const verifiedMax = verify.data.config.max_timeout_period;
            const verifiedLong = verify.data.config.long_operation_timeout;
            if (verifiedMax !== REBOOT_TIMEOUTS.maxTimeoutPeriod && verifiedMax !== Number(REBOOT_TIMEOUTS.maxTimeoutPeriod)) {
                throw new Error(`Config verification failed: max_timeout_period is ${verifiedMax} (expected ${REBOOT_TIMEOUTS.maxTimeoutPeriod})`);
            }
            if (verifiedLong !== REBOOT_TIMEOUTS.longOperationTimeout && verifiedLong !== Number(REBOOT_TIMEOUTS.longOperationTimeout)) {
                throw new Error(`Config verification failed: long_operation_timeout is ${verifiedLong} (expected ${REBOOT_TIMEOUTS.longOperationTimeout})`);
            }

            rebootTimeoutsApplied = true;
            log("info", `Reboot timeouts applied and verified: max=${verifiedMax}, long=${verifiedLong}`, "playwright");
            broadcast("pipeline", { state: "starting", message: `Reboot timeouts applied (max=${verifiedMax}, long=${verifiedLong})` });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            log("error", `CRITICAL: Failed to apply reboot timeouts for ${configName}: ${errMsg}. Aborting test run.`, "playwright");
            broadcast("pipeline", { state: "error", message: `Failed to apply reboot timeouts: ${errMsg}` });
            playwrightRunning = false;
            return res.status(500).json({ ok: false, error: `Failed to apply reboot timeouts: ${errMsg}` });
        }
    }

    playwrightRunning = true;
    pipelineResults = [];
    broadcast("pipeline", { state: "starting", message: "Starting OCTT session..." });
    log("info", `Starting OCTT session: ${configName}`, "playwright");

    // ── Step 2: Start OCTT session ──
    // Some configurations auto-start; others need an explicit call.
    // We attempt to start but continue even if it fails (session may already be active).
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const sessionResult = await octt.startSession(configName);
        log("info", `OCTT session started: ${JSON.stringify(sessionResult)}`, "playwright");
        broadcast("pipeline", { state: "starting", message: `OCTT session started. Running ${selectedTests ? selectedTests.length : "all"} tests...` });
    } catch (error) {
        log("error", `OCTT session failed: ${error}. Continuing anyway...`, "playwright");
        broadcast("pipeline", { state: "starting", message: `OCTT session failed: ${error}. Running tests anyway...` });
    }

    // ── Step 3: Build Playwright command-line arguments ──
    const projectRoot = path.resolve(__dirname, "../../..");
    const testFile = "tests/certification_pipeline.spec.ts";

    log("info", `Project root: ${projectRoot}`, "playwright");
    log("info", `Test file: ${testFile}`, "playwright");

    const args = ["test", `"${testFile}"`, "--reporter=list"];

    if (selectedTests) {
        // Build a grep pattern that matches Playwright test titles like "Execute TC_001_CS"
        const grepPattern = selectedTests.map((testId: string) => `Execute ${testId}`).join("|");
        args.push(`"--grep=${grepPattern}"`);
        log("info", `Grep: ${grepPattern}`, "playwright");
    }

    const playwrightBin = path.join(projectRoot, "node_modules", ".bin", "playwright.cmd");
    log("info", `Binary: ${playwrightBin}`, "playwright");

    playwrightProcess = spawn(playwrightBin, args, {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        env: {
            ...process.env,
            OCTT_BASE_URL: effectiveOcttConfig.baseUrl,
            OCTT_TOKEN: effectiveOcttConfig.token,
            OCTT_CONFIG: configName,
            CDS_IP: effectiveCdsIp,
            CDS_PORT: String(effectiveCdsPort),
        },
    });

    // ── Step 4: Parse Playwright stdout in real time ──
    // Playwright's list reporter outputs lines like:
    //   ok 1  › Suite: Provisioning › Execute TC_001_CS
    //   → PASS (45s)
    // We match verdict lines first (they appear before the ok/x lines)
    // and pair them up to produce structured results.
    let outputBuffer = "";
    const results: { testCase: string; verdict: string; duration: number }[] = [];
    const pendingVerdicts: { verdict: string; duration: number }[] = [];

    playwrightProcess.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter((line: string) => line.trim());

        for (const line of lines) {
            log("info", line.trim(), "playwright");
            outputBuffer += line + "\n";

            // Match verdict annotation lines like "→ PASS (45s)" or "→ INCONC (0s)"
            const verdictMatch = line.match(/→\s+(PASS|FAIL|ERROR|INCONC)\s+\((\d+)s\)/);
            if (verdictMatch) {
                pendingVerdicts.push({ verdict: verdictMatch[1].toLowerCase(), duration: parseInt(verdictMatch[2]) });
                continue;
            }

            // Match HTTP error lines that indicate an infrastructure failure
            if (line.includes("→ HTTP/RESPONSE ERROR")) {
                pendingVerdicts.push({ verdict: "error", duration: 0 });
                continue;
            }

            // Detect SUT disconnection in log output and mark as inconc
            // (hardware/network issue, not a charge-point bug)
            if (line.includes("SUT__DISCONNECTED") || line.includes("SUT_DISCONNECTED")) {
                log("warn", `SUT disconnection detected in log output`, "playwright");
                // If we have a pending verdict and it's not already pass, upgrade to inconc
                if (pendingVerdicts.length > 0 && pendingVerdicts[0].verdict !== "pass") {
                    pendingVerdicts[0].verdict = "inconc";
                }
                continue;
            }

            // Match pass/fail/skip lines from the list reporter
            const passMatch = line.match(/ok\s+\d+.*›.*Execute\s+(\S+)/);
            const failMatch = line.match(/(?:x|✘|✗|not ok)\s+\d+.*›.*Execute\s+(\S+)/);
            const skipMatch = line.match(/-\s+\d+.*›.*Execute\s+(\S+)/);

            if (passMatch || failMatch || skipMatch) {
                const testCaseId = (passMatch || failMatch || skipMatch)![1];
                let verdict = "pass";
                if (failMatch) verdict = "fail";
                if (skipMatch) verdict = "skip";

                // Pair with the earliest pending verdict if available
                if (pendingVerdicts.length > 0) {
                    const pending = pendingVerdicts.shift()!;
                    verdict = pending.verdict;
                    results.push({ testCase: testCaseId, verdict, duration: pending.duration });
                } else {
                    results.push({ testCase: testCaseId, verdict, duration: 0 });
                }
                broadcast("pipeline", { state: "testing", message: `${verdict.toUpperCase()}: ${testCaseId}`, results: results.map((r) => ({ ...r })) });
            }
        }
    });

    playwrightProcess.stderr?.on("data", (data: Buffer) => {
        const message = data.toString().trim();
        if (message) log("warn", message, "playwright");
    });

    // ── Step 5: Handle Playwright process exit ──
    playwrightProcess.on("exit", async (code) => {
        const passCount = results.filter((r) => r.verdict === "pass").length;
        const failCount = results.filter((r) => r.verdict === "fail").length;
        const inconcCount = results.filter((r) => r.verdict === "inconc").length;
        const skipCount = results.filter((r) => r.verdict === "skip").length;
        const total = results.length;

        // Always attempt to stop the OCTT session when Playwright finishes.
        // Playwright's own tear-down may have already stopped it, so we
        // silently ignore "No session active" errors.
        log("info", "Stopping OCTT session (if still active)...", "playwright");
        try {
            const octt = new OcttClient(effectiveOcttConfig);
            await octt.stopSession();
            log("info", "OCTT session stopped", "playwright");
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes("No session active") || msg.includes("400")) {
                log("info", "OCTT session was already stopped by Playwright", "playwright");
            } else {
                log("warn", `OCTT stop session failed: ${msg}`, "playwright");
            }
        }

        // ── Step 6: Restore default timeouts if reboot timeouts were applied ──
        // This ensures subsequent normal test runs are not unnecessarily slow.
        if (rebootTimeoutsApplied) {
            log("info", "Restoring default timeouts...", "playwright");
            try {
                const octt = new OcttClient(effectiveOcttConfig);

                // Stop session before saving config (OCTT requirement)
                try {
                    await octt.stopSession();
                    log("info", "Stopped existing session to restore config", "playwright");
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                } catch {
                    // No active session, ignore
                }

                const current = await octt.getConfiguration(configName);
                const updatedConfig: Record<string, unknown> = { ...current.data.config };
                updatedConfig.max_timeout_period = DEFAULT_TIMEOUTS.maxTimeoutPeriod;
                updatedConfig.long_operation_timeout = DEFAULT_TIMEOUTS.longOperationTimeout;
                updatedConfig.max_time_deviation = DEFAULT_TIMEOUTS.maxTimeDeviation;
                await octt.saveConfiguration(configName, updatedConfig);

                // Verify restoration
                const verify = await octt.getConfiguration(configName);
                log("info", `Default timeouts restored and verified: max=${verify.data.config.max_timeout_period}, long=${verify.data.config.long_operation_timeout}`, "playwright");
                broadcast("pipeline", { state: "cleaning", message: "Default timeouts restored" });
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                log("error", `Failed to restore default timeouts for ${configName}: ${errMsg}`, "playwright");
                broadcast("pipeline", { state: "error", message: `Failed to restore default timeouts: ${errMsg}` });
            }
        }

        // Convert parsed results to the ReportEntry shape for API compatibility
        pipelineResults = results.map((r) => ({
            testCaseName: r.testCase,
            verdict: r.verdict.toUpperCase(),
            duration: r.duration,
            configuration: "",
            category: "",
            description: "",
            logfile: "",
            config_version: "",
            ocppVersion: "",
            pics_mode: false,
            startTime: { date: { day: 0, month: 0, year: 0 }, time: { hour: 0, minute: 0, nano: 0, second: 0 } },
            sut: "",
            timeStr: "",
        })) as any[];

        // Determine final state: if we have results, it's "done" even if some
        // tests failed. Only mark "error" if Playwright crashed (no results).
        const hasResults = total > 0;
        const allPassed = hasResults && failCount === 0 && inconcCount === 0;
        const finalState = !hasResults ? "error" : allPassed ? "done" : "done";
        const summaryMsg = `Complete: ${passCount} pass, ${failCount} fail, ${inconcCount} inconc, ${skipCount} skip (${total} total)`;

        broadcast("pipeline", {
            state: finalState,
            message: summaryMsg,
            results: results.map((r) => ({ ...r, verdict: r.verdict.toLowerCase() })),
        });

        log("info", `Playwright exited (code ${code}): ${summaryMsg}`, "playwright");
        playwrightRunning = false;
        playwrightProcess = null;
    });

    playwrightProcess.on("error", (err) => {
        log("error", `Playwright error: ${err.message}`, "playwright");
        broadcast("pipeline", { state: "error", message: `Playwright error: ${err.message}` });
        playwrightRunning = false;
        playwrightProcess = null;
    });

    res.json({ ok: true, message: "Playwright started" });
});

/**
 * POST /api/pipeline/stop-playwright
 * Sends SIGTERM to the running Playwright child process.
 */
app.post("/api/pipeline/stop-playwright", (_req: Request, res: Response) => {
    if (!playwrightRunning || !playwrightProcess) {
        return res.status(409).json({ ok: false, error: "No Playwright running" });
    }
    playwrightProcess.kill("SIGTERM");
    playwrightRunning = false;
    playwrightProcess = null;
    broadcast("pipeline", { state: "cancelled", message: "Playwright cancelled" });
    log("warn", "Playwright cancelled", "playwright");
    res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — SSE Endpoint
// Provides a persistent text/event-stream for real-time updates.
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/events
 * Opens a Server-Sent Event stream. The client receives:
 *   - "connected"  → client ID assignment
 *   - "status"     → current service states
 *   - "pipeline"   → pipeline state changes
 *   - "log"        → real-time log entries
 *
 * The connection is kept alive automatically by the browser.
 */
app.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const clientId = ++sseIdCounter;
    sseClients.set(clientId, { id: clientId, res });

    res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

    // Immediately push the current state so the UI doesn't wait
    res.write(`event: status\ndata: ${JSON.stringify(Object.fromEntries(services))}\n\n`);
    res.write(`event: pipeline\ndata: ${JSON.stringify({ state: pipelineRunning ? "running" : "idle" })}\n\n`);

    req.on("close", () => { sseClients.delete(clientId); });
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — Jira Actions
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/jira/check
 * Validates Jira connectivity by performing a lightweight JQL search
 * limited to 1 result. Updates the Jira service status indicator.
 */
app.post("/api/jira/check", async (_req: Request, res: Response) => {
    try {
        const jiraModule = (await import("../../connectors/jira/index.js")).JiraClient;
        const client = new (jiraModule as any)(effectiveJiraConfig);
        const result = await client.search("project=" + effectiveJiraConfig.projectKey, undefined, 1);
        setService("jira", "connected", `Project: ${effectiveJiraConfig.projectKey}`);
        res.json({ ok: true, projectKey: effectiveJiraConfig.projectKey });
    } catch (error) {
        setService("jira", "error", String(error));
        res.status(500).json({ ok: false, error: String(error) });
    }
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — Reports (Download + View + Upload)
// ══════════════════════════════════════════════════════════════

/** Directory where downloaded OCTT reports are stored on disk */
const reportsDir = path.resolve(__dirname, "../../../reports");
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";

// Ensure the reports directory exists (created lazily on first use)
if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

/**
 * POST /api/reports/download
 * Downloads a single OCTT report (or all reports) in the requested format (CSV/XLS/ZIP).
 * The file is saved to ./reports/ and its metadata is returned.
 */
app.post("/api/reports/download", async (req: Request, res: Response) => {
    const { testcaseName, configurationName, format } = req.body || {};
    const reportFormat = format || "CSV";
    log("info", `Downloading report: ${testcaseName || "all"} (${reportFormat})`, "reports");
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const filter: Record<string, unknown> = { format: reportFormat };
        if (testcaseName) filter.testcase_name = [testcaseName];
        if (configurationName) filter.configuration_name = [configurationName];

        const buffer = await octt.downloadReportsFiltered(filter as any);
        const filename = testcaseName ? `${testcaseName}_${Date.now()}.${reportFormat.toLowerCase()}` : `octt_all_${Date.now()}.${reportFormat.toLowerCase()}`;
        const filepath = path.join(reportsDir, filename);
        writeFileSync(filepath, Buffer.from(buffer));
        log("info", `Report downloaded: ${filename} (${buffer.length} bytes)`, "reports");
        res.json({ ok: true, filename, filepath, size: buffer.length });
    } catch (error) {
        log("error", `Download report failed: ${error}`, "reports");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/reports/view-log
 * Fetches the CSV content of a specific test case's report and returns
 * it as a string for inline viewing in the browser.
 */
app.post("/api/reports/view-log", async (req: Request, res: Response) => {
    const { testcaseName, configurationName } = req.body || {};
    log("info", `Viewing log: ${testcaseName}`, "reports");
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const reports = await octt.getReports({ testcase_name: testcaseName });
        const entry = reports.data[0];
        if (!entry) {
            return res.json({ ok: false, error: "No report found for this test case" });
        }

        const filter: Record<string, unknown> = { format: "CSV", testcase_name: [testcaseName] };
        if (configurationName) filter.configuration_name = [configurationName];

        const buffer = await octt.downloadReportsFiltered(filter as any);
        const content = Buffer.from(buffer).toString("utf-8");
        res.json({
            ok: true,
            content,
            testcaseName,
            description: entry.description,
            verdict: entry.verdict,
            duration: entry.duration,
            startTime: entry.timeStr,
            logfile: entry.logfile,
        });
    } catch (error) {
        log("error", `View log failed: ${error}`, "reports");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/reports/upload-to-jira
 * Attaches a previously downloaded report file to an existing Jira issue.
 */
app.post("/api/reports/upload-to-jira", async (req: Request, res: Response) => {
    const { issueKey, filepath } = req.body;
    if (!issueKey || !filepath) {
        return res.status(400).json({ ok: false, error: "Missing issueKey or filepath" });
    }
    log("info", `Uploading report to ${issueKey}: ${filepath}`, "reports");
    try {
        const { JiraClient } = await import("../../connectors/jira/index.js");
        const client = new JiraClient(effectiveJiraConfig);
        const content = readFileSync(filepath);
        const filename = path.basename(filepath);
        await client.addAttachment(issueKey, filename, content);
        log("info", `Report uploaded to ${issueKey}: ${filename}`, "reports");
        res.json({ ok: true, issueKey, filename });
    } catch (error) {
        log("error", `Upload failed: ${error}`, "reports");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/reports/download-all
 * Downloads individual ZIP reports for every test case in the
 * specified configuration (or all configurations if omitted).
 */
app.post("/api/reports/download-all", async (req: Request, res: Response) => {
    const { configurationName } = req.body || {};
    log("info", `Downloading individual reports for: ${configurationName || "all"}`, "reports");
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const reports = await octt.getReports(configurationName ? { configuration_name: configurationName } : undefined);
        const downloaded: { testcase: string; filename: string; size: number }[] = [];

        for (const report of reports.data) {
            try {
                const buffer = await octt.downloadReports({ format: "ZIP", configuration_name: configurationName, logfile_name: report.logfile });
                const filename = `${report.testCaseName}_${report.logfile}.zip`;
                const filepath = path.join(reportsDir, filename);
                writeFileSync(filepath, Buffer.from(buffer));
                downloaded.push({ testcase: report.testCaseName, filename, size: buffer.length });
                log("info", `Downloaded: ${filename} (${buffer.length} bytes)`, "reports");
            } catch (error) {
                log("warn", `Failed to download report for ${report.testCaseName}: ${error}`, "reports");
            }
        }

        res.json({ ok: true, count: downloaded.length, reports: downloaded });
    } catch (error) {
        log("error", `Download all reports failed: ${error}`, "reports");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

// ══════════════════════════════════════════════════════════════
// SECTION: REST API — Jira Upload (Construction)
// Creates or updates Jira issues for failed test cases.
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/jira/upload
 * Creates a Jira Bug for a test failure, or adds a comment to an
 * existing open issue for the same test case. Also attempts to attach
 * the locally saved report ZIP if available.
 */
app.post("/api/jira/upload", async (req: Request, res: Response) => {
    const { testcase, testplan, testexecution, ocppVersion, chargerNumber, comment } = req.body;
    log("info", `Jira upload: ${testcase} | plan: ${testplan} | exec: ${testexecution} | OCPP: ${ocppVersion} | charger: ${chargerNumber}`, "jira");

    try {
        const { JiraClient } = await import("../../connectors/jira/index.js");
        const client = new JiraClient(effectiveJiraConfig);

        const existingIssue = await client.findExistingIssue(testcase, "test-fail");
        let issueKey: string;

        if (existingIssue) {
            // Update existing issue with a new occurrence comment
            issueKey = existingIssue.key;
            const commentText = `[AUTOMATED] Updated by certification pipeline\nTest Plan: ${testplan}\nTest Execution: ${testexecution}\nOCPP Version: ${ocppVersion}\nCharger: ${chargerNumber}${comment ? `\nComment: ${comment}` : ""}`;
            await client.addComment(issueKey, commentText);
            log("info", `Added comment to existing issue ${issueKey}`, "jira");
        } else {
            // Create a new Bug issue for this failure
            const summary = `[OCPP] ${testcase} — Test Failure (${testplan})`;
            const description = [
                `Test Case: ${testcase}`,
                `Test Plan: ${testplan}`,
                `Test Execution: ${testexecution}`,
                `OCPP Version: ${ocppVersion}`,
                `Charger Number: ${chargerNumber}`,
                comment ? `Comment: ${comment}` : "",
            ].filter(Boolean).join("\n");

            const issue = await client.createIssue({
                summary,
                description,
                issueType: "Bug",
                priority: "High",
                labels: ["ocpp", "certification", testcase],
            });
            issueKey = issue.key;
            log("info", `Created issue ${issueKey} for ${testcase}`, "jira");
        }

        // Attempt to attach the locally saved report if it exists
        const reportPath = path.join(reportsDir, `${testcase}_*.zip`);
        const reportFiles = existsSync(reportPath) ? [reportPath] : [];
        if (reportFiles.length > 0) {
            const content = readFileSync(reportFiles[0]);
            await client.addAttachment(issueKey, path.basename(reportFiles[0]), content);
            log("info", `Attached report to ${issueKey}`, "jira");
        }

        res.json({ ok: true, issueKey, message: existingIssue ? "Comment added" : "Issue created with attachment" });
    } catch (error) {
        log("error", `Jira upload failed: ${error}`, "jira");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

/**
 * POST /api/jira/upload-execution
 * Creates a comprehensive Test Execution summary issue in Jira
 * after a certification run completes. Includes all test results,
 * pass rate, SUT details, and firmware version.
 */
app.post("/api/jira/upload-execution", async (req: Request, res: Response) => {
    const { sut, firmwareVersion, testPlan, environment } = req.body;

    if (!sut || !firmwareVersion) {
        return res.status(400).json({ ok: false, error: "SUT and firmwareVersion are required" });
    }

    log("info", `Jira execution upload: SUT=${sut} | FW=${firmwareVersion} | Plan=${testPlan || "N/A"}`, "jira");

    try {
        const { JiraClient } = await import("../../connectors/jira/index.js");
        const client = new JiraClient(effectiveJiraConfig);

        // Build execution summary from pipeline results
        const passed = pipelineResults.filter((r) => r.verdict.toLowerCase() === "pass").length;
        const failed = pipelineResults.filter((r) => r.verdict.toLowerCase() === "fail").length;
        const inconc = pipelineResults.filter((r) => r.verdict.toLowerCase() === "inconc").length;
        const errors = pipelineResults.filter((r) => r.verdict.toLowerCase() === "error").length;
        const total = pipelineResults.length;
        const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

        const summary = `[OCPP 1.6] Test Execution — ${sut} | FW ${firmwareVersion} | ${passRate}% pass`;

        // Build detailed description with results table
        const descriptionLines = [
            `h2. Test Execution Summary`,
            ``,
            `| *SUT* | ${sut} |`,
            `| *Firmware Version* | ${firmwareVersion} |`,
            `| *Test Plan* | ${testPlan || "N/A"} |`,
            `| *Environment* | ${environment || "Production"} |`,
            `| *Execution Date* | ${new Date().toISOString()} |`,
            `| *OCPP Version* | 1.6 |`,
            `| *Role* | Charging Station (CS) |`,
            ``,
            `h2. Results Overview`,
            ``,
            `| *Total* | *Passed* | *Failed* | *Inconclusive* | *Errors* | *Pass Rate* |`,
            `| ${total} | ${passed} | ${failed} | ${inconc} | ${errors} | ${passRate}% |`,
            ``,
            `h2. Detailed Results`,
            ``,
            `| *Test Case* | *Suite* | *Verdict* | *Duration* |`,
        ];

        for (const result of pipelineResults) {
            const suite = Object.entries(testSuites).find(([, tests]) =>
                tests.includes(result.testCaseName)
            )?.[0] || "Unknown";
            descriptionLines.push(`| ${result.testCaseName} | ${suite} | ${result.verdict} | ${result.duration}s |`);
        }

        descriptionLines.push(
            ``,
            `h2. Non-Passing Tests`,
            ``
        );

        const nonPassing = pipelineResults.filter((r) => r.verdict.toLowerCase() !== "pass");
        if (nonPassing.length === 0) {
            descriptionLines.push("All tests passed! 🎉");
        } else {
            for (const result of nonPassing) {
                descriptionLines.push(`* ${result.testCaseName}: ${result.verdict} (${result.duration}s)`);
            }
        }

        const description = descriptionLines.join("\n");

        // Create the Test Execution issue
        const issue = await client.createIssue({
            summary,
            description,
            issueType: "Task",
            priority: failed > 0 ? "High" : "Medium",
            labels: ["ocpp", "certification", "test-execution", "ocpp1.6", sut.toLowerCase().replace(/\s+/g, "-")],
        });

        log("info", `Created Test Execution ${issue.key} in Jira`, "jira");

        // Attach results as JSON file
        const resultsJson = JSON.stringify({
            meta: {
                sut,
                firmwareVersion,
                testPlan,
                environment,
                executionDate: new Date().toISOString(),
                ocppVersion: "1.6",
                role: "CS",
            },
            summary: { total, passed, failed, inconc, errors, passRate },
            results: pipelineResults,
        }, null, 2);

        const buffer = Buffer.from(resultsJson, "utf-8");
        await client.addAttachment(issue.key, `test-results-${sut}-${firmwareVersion}.json`, buffer);
        log("info", `Attached results JSON to ${issue.key}`, "jira");

        res.json({
            ok: true,
            issueKey: issue.key,
            url: `${effectiveJiraConfig.baseUrl}/browse/${issue.key}`,
            summary: { total, passed, failed, inconc, errors, passRate },
        });
    } catch (error) {
        log("error", `Jira execution upload failed: ${error}`, "jira");
        res.status(500).json({ ok: false, error: String(error) });
    }
});

// ══════════════════════════════════════════════════════════════
// SECTION: SUT API (System Under Test)
// OCTT calls these endpoints during test execution to simulate
// EV plug-in and plug-out events via the CDS.
// ══════════════════════════════════════════════════════════════

/** Singleton CDS client used exclusively for SUT API calls */
let sutCds: CdsClient | null = null;

/**
 * Returns a connected CDS client for SUT operations.
 * Reuses an existing connection if already open; otherwise creates
 * a new one and connects automatically.
 */
async function getSutCds(): Promise<CdsClient> {
    if (!sutCds || !sutCds.isConnected) {
        sutCds = new CdsClient(effectiveCdsIp, effectiveCdsPort);
        await sutCds.connect();
    }
    return sutCds;
}

/**
 * POST /api/sut/*
 * Proxy endpoint that OCTT calls during tests to control the simulated EV.
 * Supported operations:
 *   - plugin / start  → Configure CDS for DC ISO 15118, set EV params, start simulation
 *   - plugout / stop  → Stop simulation, set CP state to A1 (disconnected)
 *   - reset           → Perform a full CDS reset
 */
app.use("/api/sut", async (req: Request, res: Response) => {
    const operation = req.path.split("/").pop() || "base";
    const connectorId = req.query.connector_id?.toString() || "1";
    log("info", `SUT API: ${operation} (connector ${connectorId})`, "sut");

    try {
        const cds = await getSutCds();

        if (operation === "plugin" || operation === "start") {
            // Configure CDS for DC CCS simulation and set EV to ready state (B2)
            log("info", "Plugin: configuring CDS + EV + CpState B2", "sut");
            await cds.configureCds({ specification: Specification.ISO_15118, chargeMode: ChargeMode.DC, sinkId: 12, mode: 2 });
            await cds.configureEv({
                EVMaximumCurrentLimit: 300, EVMaximumVoltageLimit: 900,
                EVMaximumPowerLimit: 50000, EVMinimumCurrentLimit: 0,
                EVMinimumVoltageLimit: 800, EVstateOfCharge: 20,
                BatteryCapacity: 50000,
            });
            cds.writeSinglePid(PidList.CpStateEv, "int32", 3);
            await cds.start();
            log("info", "Plugin complete — EV ready", "sut");

        } else if (operation === "plugout" || operation === "stop") {
            // Stop simulation and set CP state to A1 (physically disconnected)
            log("info", "Plugout: stopping CDS + CpState A1", "sut");
            await cds.stop();
            cds.writeSinglePid(PidList.CpStateEv, "int32", 1);
            log("info", "Plugout complete — EV disconnected", "sut");

        } else if (operation === "reset") {
            log("info", "Resetting CDS", "sut");
            await cds.reset();
            log("info", "CDS reset complete", "sut");
        }

        res.status(200).send("OK");
    } catch (error) {
        log("error", `SUT API error: ${error}`, "sut");
        res.status(500).send(String(error));
    }
});

// ══════════════════════════════════════════════════════════════
// SECTION: Config Persistence
// The dashboard supports saving connection settings via the UI.
// Values are stored in dashboard-config.json and take precedence
// over environment variables. This allows non-technical users to
// configure the system without editing .env files.
// ══════════════════════════════════════════════════════════════

/** Absolute path to the JSON file that persists dashboard settings */
const configPath = path.resolve(__dirname, "../../../dashboard-config.json");

/**
 * Shape of the persisted dashboard configuration.
 * All fields are optional at the file level because they fall back
 * to environment variables if missing.
 */
interface SavedConfig {
    octtBaseUrl: string;
    octtToken: string;
    octtOcppVersion: string;
    octtRole: string;
    cdsIp: string;
    cdsPort: number;
    jiraBaseUrl: string;
    jiraEmail: string;
    jiraApiToken: string;
    jiraProjectKey: string;
}

/** Default values used when no persisted config exists */
const defaultConfig: SavedConfig = {
    octtBaseUrl: "",
    octtToken: "",
    octtOcppVersion: "ocpp1.6",
    octtRole: "CS",
    cdsIp: "192.168.100.10",
    cdsPort: 51001,
    jiraBaseUrl: "",
    jiraEmail: "",
    jiraApiToken: "",
    jiraProjectKey: "CERT",
};

/**
 * Loads the saved dashboard configuration from disk.
 * Returns default values if the file is missing or unreadable.
 */
function loadSavedConfig(): SavedConfig {
    try {
        if (existsSync(configPath)) {
            const raw = readFileSync(configPath, "utf-8");
            return { ...defaultConfig, ...JSON.parse(raw) };
        }
    } catch {
        // Silently fall back to defaults if the file is corrupt or unreadable
    }
    return defaultConfig;
}

/**
 * Persists the dashboard configuration to disk as formatted JSON.
 *
 * @param cfg - Configuration object to save
 */
function saveConfig(cfg: SavedConfig): void {
    try {
        writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
        log("info", "Config saved to dashboard-config.json", "config");
    } catch (error) {
        log("error", `Failed to save config: ${error}`, "config");
    }
}

/** In-memory copy of the persisted configuration */
let savedConfig = loadSavedConfig();

// Merge .env defaults with saved config (saved config wins for UI display)
const effectiveOcttConfig = {
    baseUrl: savedConfig.octtBaseUrl || octtConfig.baseUrl,
    token: savedConfig.octtToken || octtConfig.token,
    ocppVersion: savedConfig.octtOcppVersion || octtConfig.ocppVersion,
    role: (savedConfig.octtRole || octtConfig.role) as "CS" | "CSMS",
};

const effectiveCdsIp = savedConfig.cdsIp || cdsDefaultIp;
const effectiveCdsPort = savedConfig.cdsPort || cdsDefaultPort;

const effectiveJiraConfig = {
    baseUrl: savedConfig.jiraBaseUrl || jiraConfig.baseUrl,
    email: savedConfig.jiraEmail || jiraConfig.email,
    apiToken: savedConfig.jiraApiToken || jiraConfig.apiToken,
    projectKey: savedConfig.jiraProjectKey || jiraConfig.projectKey,
};

/**
 * GET /api/config
 * Returns the currently active configuration (with masked token)
 * so the frontend can pre-fill input fields on load.
 */
app.get("/api/config", (_req: Request, res: Response) => {
    res.json({
        octtBaseUrl: effectiveOcttConfig.baseUrl,
        octtToken: effectiveOcttConfig.token ? effectiveOcttConfig.token.slice(0, 8) + "..." : "",
        octtOcppVersion: effectiveOcttConfig.ocppVersion,
        octtRole: effectiveOcttConfig.role,
        cdsIp: effectiveCdsIp,
        cdsPort: effectiveCdsPort,
        jiraBaseUrl: effectiveJiraConfig.baseUrl,
        jiraEmail: effectiveJiraConfig.email,
        jiraProjectKey: effectiveJiraConfig.projectKey,
    });
});

/**
 * POST /api/config
 * Saves updated configuration values from the frontend.
 * Restarts the SUT relay agent so it picks up new OCTT credentials.
 */
app.post("/api/config", (req: Request, res: Response) => {
    const { octtBaseUrl, octtToken, octtOcppVersion, octtRole, cdsIp, cdsPort, jiraBaseUrl, jiraEmail, jiraApiToken, jiraProjectKey } = req.body;

    savedConfig = {
        octtBaseUrl: octtBaseUrl ?? savedConfig.octtBaseUrl,
        octtToken: octtToken ?? savedConfig.octtToken,
        octtOcppVersion: octtOcppVersion ?? savedConfig.octtOcppVersion,
        octtRole: octtRole ?? savedConfig.octtRole,
        cdsIp: cdsIp ?? savedConfig.cdsIp,
        cdsPort: cdsPort ?? savedConfig.cdsPort,
        jiraBaseUrl: jiraBaseUrl ?? savedConfig.jiraBaseUrl,
        jiraEmail: jiraEmail ?? savedConfig.jiraEmail,
        jiraApiToken: jiraApiToken ?? savedConfig.jiraApiToken,
        jiraProjectKey: jiraProjectKey ?? savedConfig.jiraProjectKey,
    };

    saveConfig(savedConfig);

    // Update effective configs immediately so subsequent API calls use new values
    effectiveOcttConfig.baseUrl = savedConfig.octtBaseUrl;
    effectiveOcttConfig.token = savedConfig.octtToken;
    effectiveOcttConfig.ocppVersion = savedConfig.octtOcppVersion;
    effectiveOcttConfig.role = savedConfig.octtRole as "CS" | "CSMS";

    // Restart relay agent with new OCTT host/token
    stopRelayAgent();
    startRelayAgent();

    res.json({ ok: true, message: "Config saved", relayRunning: relayProcess !== null });
});

// ══════════════════════════════════════════════════════════════
// SECTION: Static Frontend
// Serves the compiled/index.html dashboard and downloaded reports.
// ══════════════════════════════════════════════════════════════

app.use(express.static(path.join(__dirname, "public")));
app.use("/reports", express.static(reportsDir));

app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ══════════════════════════════════════════════════════════════
// SECTION: SUT Relay Agent
// A Python subprocess that forwards OCTT SUT API calls to this
// dashboard server. This is needed when OCTT cannot reach the
// dashboard directly (e.g., different network segments).
// ══════════════════════════════════════════════════════════════

/** Handle to the Python relay agent child process */
let relayProcess: ChildProcess | null = null;

/**
 * Starts the Python SUT API relay agent if OCTT credentials are configured.
 * The relay agent runs sut_api_relay.py and forwards OCTT SUT requests
 * to the local dashboard's /api/sut endpoints.
 */
function startRelayAgent(): void {
    // Strip protocol and trailing path from the URL to get a bare hostname
    const octtHost = effectiveOcttConfig.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const octtToken = effectiveOcttConfig.token;

    // Skip startup if credentials are missing or pointing to localhost
    if (!octtHost || octtHost === "localhost" || !octtToken) {
        log("warn", "Relay agent skipped — OCTT_BASE_URL or OCTT_TOKEN not configured", "relay");
        return;
    }

    const relayScript = path.resolve(__dirname, "../../../sut-api-relay-agent/documentation/sut-api-relay/sut_api_relay.py");

    try {
        relayProcess = spawn("python", [relayScript, `--octt-host=${octtHost}`, `--octt-token=${octtToken}`], {
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
        });

        relayProcess.stdout?.on("data", (data: Buffer) => {
            const message = data.toString().trim();
            if (message) log("info", message, "relay");
        });

        relayProcess.stderr?.on("data", (data: Buffer) => {
            const message = data.toString().trim();
            if (message) log("warn", message, "relay");
        });

        relayProcess.on("exit", (code) => {
            log("warn", `Relay agent exited (code ${code})`, "relay");
            relayProcess = null;
        });

        relayProcess.on("error", (err) => {
            log("error", `Relay agent failed to start: ${err.message}`, "relay");
            relayProcess = null;
        });

        log("info", `Relay agent started → ${octtHost}`, "relay");
    } catch (error) {
        log("error", `Relay agent spawn error: ${error}`, "relay");
    }
}

/**
 * Terminates the relay agent subprocess if it is running.
 */
function stopRelayAgent(): void {
    if (relayProcess) {
        relayProcess.kill("SIGTERM");
        relayProcess = null;
        log("info", "Relay agent stopped", "relay");
    }
}

/**
 * POST /api/relay/status
 * Returns whether the relay agent is currently running and its PID.
 */
app.post("/api/relay/status", (_req: Request, res: Response) => {
    res.json({
        running: relayProcess !== null,
        pid: relayProcess?.pid ?? null,
    });
});

/**
 * POST /api/relay/restart
 * Stops and restarts the relay agent (useful after config changes).
 */
app.post("/api/relay/restart", (_req: Request, res: Response) => {
    stopRelayAgent();
    startRelayAgent();
    res.json({ ok: true, running: relayProcess !== null });
});

// ══════════════════════════════════════════════════════════════
// SECTION: Server Bootstrap
// ══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`[Cert Dashboard] Running on http://localhost:${PORT}`);
    log("info", `Dashboard started on port ${PORT}`, "dashboard");
    startRelayAgent();
});

// Graceful shutdown: ensure the relay agent is terminated on exit
process.on("SIGINT", () => { stopRelayAgent(); process.exit(0); });
process.on("SIGTERM", () => { stopRelayAgent(); process.exit(0); });
