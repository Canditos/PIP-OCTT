// ══════════════════════════════════════════════════════════════
// Certification Dashboard — Backend Server
// REST API + SSE streaming for real-time pipeline monitoring
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.CERT_DASHBOARD_PORT ?? "3101", 10);

// ── SSE infrastructure ──

interface SseClient {
    id: number;
    res: Response;
}

let sseIdCounter = 0;
const sseClients = new Map<number, SseClient>();

function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [, c] of sseClients) {
        c.res.write(payload);
    }
}

function log(level: string, message: string, service?: string) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        service: service ?? "dashboard",
    };
    console.log(`[${entry.timestamp}] [${entry.service}] ${message}`);
    broadcast("log", entry);
}

// ── Service state ──

interface ServiceState {
    status: "disconnected" | "connecting" | "connected" | "running" | "error";
    label: string;
    info: string;
}

const services = new Map<string, ServiceState>([
    ["cds", { status: "disconnected", label: "CDS", info: "Keysight SL1040A" }],
    ["octt", { status: "disconnected", label: "OCTT", info: "Compliance Testing Tool" }],
    ["jira", { status: "disconnected", label: "Jira", info: "Issue Tracking" }],
]);

function setService(service: string, status: ServiceState["status"], info?: string) {
    const s = services.get(service)!;
    s.status = status;
    if (info) s.info = info;
    broadcast("status", { service, status, info: s.info });
}

// ── Config ──

const octtConfig = {
    baseUrl: process.env.OCTT_BASE_URL || "",
    token: process.env.OCTT_TOKEN || "",
    ocppVersion: process.env.OCTT_OCPP_VERSION ?? "ocpp1.6",
    role: (process.env.OCTT_ROLE ?? "CS") as "CS" | "CSMS",
};

const cdsDefaultIp = process.env.CDS_IP || "192.168.100.10";
const cdsDefaultPort = parseInt(process.env.CDS_PORT ?? "51001", 10);

const jiraConfig = {
    baseUrl: process.env.JIRA_BASE_URL || "",
    email: process.env.JIRA_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    projectKey: process.env.JIRA_PROJECT_KEY ?? "CERT",
};

// ── Charge Profiles ──

interface ChargeProfile {
    label: string;
    specification: Specification;
    cdsConfig: CdsConfig;
    evConfig: EvConfig;
}

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

// ── Pipeline state ──

let orchestrator: Orchestrator | null = null;
let pipelineRunning = false;
let pipelineResults: ReportEntry[] = [];

// ── REST API ──

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

app.get("/api/profiles", (_req: Request, res: Response) => {
    const profiles = Object.entries(chargeProfiles).map(([key, p]) => ({
        name: key,
        label: p.label,
        spec: Specification[p.specification],
        evConfig: p.evConfig,
    }));
    res.json(profiles);
});

app.get("/api/results", (_req: Request, res: Response) => {
    const results = pipelineResults.map((r) => ({
        testCase: r.testCaseName,
        verdict: r.verdict.toLowerCase(),
        duration: r.duration,
        configuration: r.configuration,
        category: r.category,
        description: r.description,
        logfile: r.logfile,
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

app.get("/api/logs", (_req: Request, res: Response) => {
    if (orchestrator) {
        res.json(orchestrator.getLog());
    } else {
        res.json([]);
    }
});

// ── CDS actions ──

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
    } catch (e) {
        setService("cds", "error", String(e));
        res.status(500).json({ ok: false, error: String(e) });
    }
});

app.post("/api/cds/configure", async (req: Request, res: Response) => {
    const { ip, port, profile } = req.body;
    const p = chargeProfiles[profile ?? "CCS_900V_300A"] ?? chargeProfiles["CCS_900V_300A"]!;
    const cds = new CdsClient(ip ?? effectiveCdsIp, port ?? effectiveCdsPort);
    log("info", `Configuring CDS: ${p.label}`, "cds");
    try {
        await cds.connect();
        await cds.reset();
        await cds.configureCds(p.cdsConfig);
        await cds.configureEv(p.evConfig);
        await cds.disconnect();
        setService("cds", "connected", `${cds.ip}:${cds.port} — ${p.label}`);
        log("info", "CDS configuration complete", "cds");
        res.json({ ok: true, profile: p.label });
    } catch (e) {
        setService("cds", "error", String(e));
        res.status(500).json({ ok: false, error: String(e) });
    }
});

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
    } catch (e) {
        setService("cds", "error", String(e));
        res.status(500).json({ ok: false, error: String(e) });
    }
});

// ── OCTT actions ──

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
    } catch (e) {
        setService("octt", "error", String(e));
        res.status(500).json({ ok: false, error: String(e) });
    }
});

app.post("/api/octt/testcases", async (req: Request, res: Response) => {
    const { configurationName } = req.body;
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const result = await octt.listTestCases(configurationName);
        const testcases = result.data.testcasesData.flatMap((g) => g.data);
        res.json({ ok: true, testcases });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

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
                testcases = tc.data.testcasesData.flatMap((g) => g.data);
            } catch { /* ignore */ }
        }
        res.json({ ok: true, url: cfg.baseUrl, exists, configurations: configs.configurations, sessionStatus, testcasesCount: testcases.length });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e), url: cfg.baseUrl });
    }
});

// ── Config Timeouts ──

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
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

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
    } catch (e) {
        log("error", `Failed to update timeouts: ${e}`, "octt");
        res.status(500).json({ ok: false, error: String(e) });
    }
});

// ── Reboot Test Helpers ──

const REBOOT_TIMEOUTS = {
    maxTimeoutPeriod: "600",
    longOperationTimeout: "650",
    maxTimeDeviation: "4",
};

const DEFAULT_TIMEOUTS = {
    maxTimeoutPeriod: "70",
    longOperationTimeout: "450",
    maxTimeDeviation: "4",
};

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
    } catch (e) {
        log("error", `Failed to apply reboot timeouts: ${e}`, "octt");
        res.status(500).json({ ok: false, error: String(e) });
    }
});

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
    } catch (e) {
        log("error", `Failed to restore default timeouts: ${e}`, "octt");
        res.status(500).json({ ok: false, error: String(e) });
    }
});

// ── Test case list (static from Playwright test) ──

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
    "REBOOT": ["TC_001_CS", "TC_002_CS", "TC_013_CS", "TC_014_CS", "TC_015_CS", "TC_016_CS", "TC_032_1_CS", "TC_032_2_CS", "TC_034_CS"],
};

app.get("/api/testcases", (_req: Request, res: Response) => {
    res.json(testSuites);
});

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

app.get("/api/testcases/details", (_req: Request, res: Response) => {
    res.json(testDescriptions);
});

// ── Pipeline control ──

app.post("/api/pipeline/start", async (req: Request, res: Response) => {
    if (pipelineRunning) {
        return res.status(409).json({ ok: false, error: "Pipeline already running" });
    }

    const { profile, configurationName, testcaseNames, cdsIp, cdsPort } = req.body;
    const p = chargeProfiles[profile ?? "CCS_900V_300A"] ?? chargeProfiles["CCS_900V_300A"]!;

    pipelineRunning = true;
    pipelineResults = [];
    broadcast("pipeline", { state: "starting", message: `Starting pipeline: ${p.label}` });
    log("info", `Pipeline starting — profile: ${p.label}, config: ${configurationName}`, "pipeline");

    setService("cds", "connecting");
    setService("octt", "connecting");

    orchestrator = new Orchestrator({
        octt: effectiveOcttConfig,
        cds: { ip: cdsIp ?? effectiveCdsIp, port: cdsPort ?? effectiveCdsPort },
        jira: effectiveJiraConfig,
        cdsConfig: p.cdsConfig,
        evConfig: p.evConfig,
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
        setService("cds", "running", p.label);
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
    } catch (e) {
        broadcast("pipeline", { state: "error", message: String(e) });
        log("error", String(e), "pipeline");
        try { await orchestrator?.cleanup(); } catch { /* ignore */ }
    } finally {
        pipelineRunning = false;
    }
});

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

// ── Playwright runner ──

let playwrightProcess: ChildProcess | null = null;
let playwrightRunning = false;

app.post("/api/pipeline/run-playwright", async (req: Request, res: Response) => {
    if (playwrightRunning) {
        return res.status(409).json({ ok: false, error: "Playwright already running" });
    }

    const { testcaseNames, configurationName } = req.body || {};
    const selectedTests = testcaseNames && testcaseNames.length > 0 ? testcaseNames : null;
    const configName = configurationName || "AUT_SID_SAT";

    playwrightRunning = true;
    pipelineResults = [];
    broadcast("pipeline", { state: "starting", message: "Starting OCTT session..." });
    log("info", `Starting OCTT session: ${configName}`, "playwright");

    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const sessionResult = await octt.startSession(configName);
        log("info", `OCTT session started: ${JSON.stringify(sessionResult)}`, "playwright");
        broadcast("pipeline", { state: "starting", message: `OCTT session started. Running ${selectedTests ? selectedTests.length : "all"} tests...` });
    } catch (e) {
        log("error", `OCTT session failed: ${e}. Continuing anyway...`, "playwright");
        broadcast("pipeline", { state: "starting", message: `OCTT session failed: ${e}. Running tests anyway...` });
    }

    const projectRoot = path.resolve(__dirname, "../../..");
    const testFile = "tests/certification_pipeline.spec.ts";

    log("info", `Project root: ${projectRoot}`, "playwright");
    log("info", `Test file: ${testFile}`, "playwright");

    const args = ["test", `"${testFile}"`, "--reporter=list"];

    if (selectedTests) {
        const grepPattern = selectedTests.map((t: string) => `Execute ${t}`).join("|");
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

    let output = "";
    const results: { testCase: string; verdict: string; duration: number }[] = [];
    const pendingVerdicts: { verdict: string; duration: number }[] = [];

    playwrightProcess.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter((l: string) => l.trim());

        for (const line of lines) {
            log("info", line.trim(), "playwright");
            output += line + "\n";

            const verdictMatch = line.match(/→\s+(PASS|FAIL|ERROR|INCONC)\s+\((\d+)s\)/);
            if (verdictMatch) {
                pendingVerdicts.push({ verdict: verdictMatch[1].toLowerCase(), duration: parseInt(verdictMatch[2]) });
                continue;
            }

            if (line.includes("→ HTTP/RESPONSE ERROR")) {
                pendingVerdicts.push({ verdict: "error", duration: 0 });
                continue;
            }

            const passMatch = line.match(/ok\s+\d+.*›.*Execute\s+(\S+)/);
            const failMatch = line.match(/(?:x|✘|✗|not ok)\s+\d+.*›.*Execute\s+(\S+)/);
            const skipMatch = line.match(/-\s+\d+.*›.*Execute\s+(\S+)/);

            if (passMatch || failMatch || skipMatch) {
                const tc = (passMatch || failMatch || skipMatch)![1];
                let verdict = "pass";
                if (failMatch) verdict = "fail";
                if (skipMatch) verdict = "skip";

                if (pendingVerdicts.length > 0) {
                    const pv = pendingVerdicts.shift()!;
                    verdict = pv.verdict;
                    results.push({ testCase: tc, verdict, duration: pv.duration });
                } else {
                    results.push({ testCase: tc, verdict, duration: 0 });
                }
                broadcast("pipeline", { state: "testing", message: `${verdict.toUpperCase()}: ${tc}`, results: results.map(r => ({ ...r })) });
            }
        }
    });

    playwrightProcess.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log("warn", msg, "playwright");
    });

    playwrightProcess.on("exit", async (code) => {
        const passCount = results.filter(r => r.verdict === "pass").length;
        const failCount = results.filter(r => r.verdict === "fail").length;
        const skipCount = results.filter(r => r.verdict === "skip").length;
        const total = results.length;

        log("info", "Stopping OCTT session...", "playwright");
        try {
            const octt = new OcttClient(effectiveOcttConfig);
            await octt.stopSession();
            log("info", "OCTT session stopped", "playwright");
        } catch (e) {
            log("warn", `OCTT stop session failed: ${e}`, "playwright");
        }

        pipelineResults = results.map(r => ({
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

        broadcast("pipeline", {
            state: code === 0 ? "done" : "error",
            message: `Playwright finished (${code}): ${passCount}/${total} passed, ${failCount} failed, ${skipCount} skipped`,
            results: results.map(r => ({ ...r, verdict: r.verdict.toLowerCase() })),
        });

        log("info", `Playwright exited (code ${code}): ${passCount}/${total} passed`, "playwright");
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

// ── SSE endpoint ──

app.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const id = ++sseIdCounter;
    sseClients.set(id, { id, res });

    res.write(`event: connected\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

    // Send current state
    res.write(`event: status\ndata: ${JSON.stringify(Object.fromEntries(services))}\n\n`);
    res.write(`event: pipeline\ndata: ${JSON.stringify({ state: pipelineRunning ? "running" : "idle" })}\n\n`);

    req.on("close", () => { sseClients.delete(id); });
});

// ── Jira actions ──

app.post("/api/jira/check", async (_req: Request, res: Response) => {
    try {
        const jira = (await import("../../connectors/jira/index.js")).JiraClient;
        const client = new (jira as any)(effectiveJiraConfig);
        const result = await client.search("project=" + effectiveJiraConfig.projectKey, undefined, 1);
        setService("jira", "connected", `Project: ${effectiveJiraConfig.projectKey}`);
        res.json({ ok: true, projectKey: effectiveJiraConfig.projectKey });
    } catch (e) {
        setService("jira", "error", String(e));
        res.status(500).json({ ok: false, error: String(e) });
    }
});

// ── Reports download + Jira upload (construction) ──

const reportsDir = path.resolve(__dirname, "../../../reports");
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";

if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

app.post("/api/reports/download", async (req: Request, res: Response) => {
    const { testcaseName, configurationName, format } = req.body || {};
    const fmt = format || "CSV";
    log("info", `Downloading report: ${testcaseName || "all"} (${fmt})`, "reports");
    try {
        const octt = new OcttClient(effectiveOcttConfig);
        const filter: Record<string, unknown> = { format: fmt };
        if (testcaseName) filter.testcase_name = [testcaseName];
        if (configurationName) filter.configuration_name = [configurationName];

        const buffer = await octt.downloadReportsFiltered(filter as any);
        const filename = testcaseName ? `${testcaseName}_${Date.now()}.${fmt.toLowerCase()}` : `octt_all_${Date.now()}.${fmt.toLowerCase()}`;
        const filepath = path.join(reportsDir, filename);
        writeFileSync(filepath, Buffer.from(buffer));
        log("info", `Report downloaded: ${filename} (${buffer.length} bytes)`, "reports");
        res.json({ ok: true, filename, filepath, size: buffer.length });
    } catch (e) {
        log("error", `Download report failed: ${e}`, "reports");
        res.status(500).json({ ok: false, error: String(e) });
    }
});

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
    } catch (e) {
        log("error", `View log failed: ${e}`, "reports");
        res.status(500).json({ ok: false, error: String(e) });
    }
});

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
    } catch (e) {
        log("error", `Upload failed: ${e}`, "reports");
        res.status(500).json({ ok: false, error: String(e) });
    }
});

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
            } catch (e) {
                log("warn", `Failed to download report for ${report.testCaseName}: ${e}`, "reports");
            }
        }

        res.json({ ok: true, count: downloaded.length, reports: downloaded });
    } catch (e) {
        log("error", `Download all reports failed: ${e}`, "reports");
        res.status(500).json({ ok: false, error: String(e) });
    }
});

// ── Jira upload endpoint (construction) ──

app.post("/api/jira/upload", async (req: Request, res: Response) => {
    const { testcase, testplan, testexecution, ocppVersion, chargerNumber, comment } = req.body;
    log("info", `Jira upload: ${testcase} | plan: ${testplan} | exec: ${testexecution} | OCPP: ${ocppVersion} | charger: ${chargerNumber}`, "jira");

    try {
        const { JiraClient } = await import("../../connectors/jira/index.js");
        const client = new JiraClient(effectiveJiraConfig);

        const existingIssue = await client.findExistingIssue(testcase, "test-fail");
        let issueKey: string;

        if (existingIssue) {
            issueKey = existingIssue.key;
            const commentText = `[AUTOMATED] Updated by certification pipeline\nTest Plan: ${testplan}\nTest Execution: ${testexecution}\nOCPP Version: ${ocppVersion}\nCharger: ${chargerNumber}${comment ? `\nComment: ${comment}` : ""}`;
            await client.addComment(issueKey, commentText);
            log("info", `Added comment to existing issue ${issueKey}`, "jira");
        } else {
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

        const reportPath = path.join(reportsDir, `${testcase}_*.zip`);
        const reportFiles = existsSync(reportPath) ? [reportPath] : [];
        if (reportFiles.length > 0) {
            const content = readFileSync(reportFiles[0]);
            await client.addAttachment(issueKey, path.basename(reportFiles[0]), content);
            log("info", `Attached report to ${issueKey}`, "jira");
        }

        res.json({ ok: true, issueKey, message: existingIssue ? "Comment added" : "Issue created with attachment" });
    } catch (e) {
        log("error", `Jira upload failed: ${e}`, "jira");
        res.status(500).json({ ok: false, error: String(e) });
    }
});

// ── SUT API (OCTT calls this for plugin/plugout during tests) ──

let sutCds: CdsClient | null = null;

async function getSutCds(): Promise<CdsClient> {
    if (!sutCds || !sutCds.isConnected) {
        sutCds = new CdsClient(effectiveCdsIp, effectiveCdsPort);
        await sutCds.connect();
    }
    return sutCds;
}

app.use("/api/sut", async (req: Request, res: Response) => {
    const operation = req.path.split("/").pop() || "base";
    const connectorId = req.query.connector_id?.toString() || "1";
    log("info", `SUT API: ${operation} (connector ${connectorId})`, "sut");

    try {
        const cds = await getSutCds();

        if (operation === "plugin" || operation === "start") {
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
    } catch (e) {
        log("error", `SUT API error: ${e}`, "sut");
        res.status(500).send(String(e));
    }
});

// ── Config persistence ──

const configPath = path.resolve(__dirname, "../../../dashboard-config.json");

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

function loadSavedConfig(): SavedConfig {
    try {
        if (existsSync(configPath)) {
            const raw = readFileSync(configPath, "utf-8");
            return { ...defaultConfig, ...JSON.parse(raw) };
        }
    } catch { /* ignore */ }
    return defaultConfig;
}

function saveConfig(cfg: SavedConfig): void {
    try {
        writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
        log("info", "Config saved to dashboard-config.json", "config");
    } catch (e) {
        log("error", `Failed to save config: ${e}`, "config");
    }
}

let savedConfig = loadSavedConfig();

// Merge .env with saved config (saved config takes precedence for UI)
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

    // Update effective configs
    effectiveOcttConfig.baseUrl = savedConfig.octtBaseUrl;
    effectiveOcttConfig.token = savedConfig.octtToken;
    effectiveOcttConfig.ocppVersion = savedConfig.octtOcppVersion;
    effectiveOcttConfig.role = savedConfig.octtRole as "CS" | "CSMS";

    // Restart relay agent with new config
    stopRelayAgent();
    startRelayAgent();

    res.json({ ok: true, message: "Config saved", relayRunning: relayProcess !== null });
});

// ── Static frontend ──

app.use(express.static(path.join(__dirname, "public")));
app.use("/reports", express.static(reportsDir));

app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── SUT Relay Agent ──

let relayProcess: ChildProcess | null = null;

function startRelayAgent(): void {
    const octtHost = effectiveOcttConfig.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const octtToken = effectiveOcttConfig.token;

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
            const msg = data.toString().trim();
            if (msg) log("info", msg, "relay");
        });

        relayProcess.stderr?.on("data", (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) log("warn", msg, "relay");
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
    } catch (e) {
        log("error", `Relay agent spawn error: ${e}`, "relay");
    }
}

function stopRelayAgent(): void {
    if (relayProcess) {
        relayProcess.kill("SIGTERM");
        relayProcess = null;
        log("info", "Relay agent stopped", "relay");
    }
}

app.post("/api/relay/status", (_req: Request, res: Response) => {
    res.json({
        running: relayProcess !== null,
        pid: relayProcess?.pid ?? null,
    });
});

app.post("/api/relay/restart", (_req: Request, res: Response) => {
    stopRelayAgent();
    startRelayAgent();
    res.json({ ok: true, running: relayProcess !== null });
});

// ── Start server ──

app.listen(PORT, () => {
    console.log(`[Cert Dashboard] Running on http://localhost:${PORT}`);
    log("info", `Dashboard started on port ${PORT}`, "dashboard");
    startRelayAgent();
});

process.on("SIGINT", () => { stopRelayAgent(); process.exit(0); });
process.on("SIGTERM", () => { stopRelayAgent(); process.exit(0); });
