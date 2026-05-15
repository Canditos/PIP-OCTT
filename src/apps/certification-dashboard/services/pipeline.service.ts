// ══════════════════════════════════════════════════════════════
// Pipeline Service — Playwright runner and result tracking
// ══════════════════════════════════════════════════════════════

import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { OcttClient } from "../../../connectors/octt/index.js";
import { log as broadcastLog } from "../routes/logs.routes.js";
import { broadcast } from "./sse.service.js";
import { effectiveConfig } from "../config/dashboard.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let playwrightProcess: ChildProcess | null = null;
let isRunning = false;
let lastResults: any[] = [];

export function isPlaywrightRunning(): boolean {
    return isRunning;
}

export function getLastResults(): any[] {
    return lastResults;
}

const REBOOT_TESTS = ["TC_001_CS", "TC_002_CS", "TC_013_CS", "TC_014_CS", "TC_015_CS", "TC_016_CS", "TC_032_1_CS", "TC_032_2_CS", "TC_034_CS"];
const REBOOT_TIMEOUTS = { maxTimeoutPeriod: "600", longOperationTimeout: "650", maxTimeDeviation: "4" };
const DEFAULT_TIMEOUTS = { maxTimeoutPeriod: "70", longOperationTimeout: "450", maxTimeDeviation: "4" };

export async function runPlaywright(testcaseNames: string[], configName: string): Promise<{ ok: boolean; error?: string }> {
    if (isRunning) return { ok: false, error: "Playwright already running" };

    const hasReboot = testcaseNames.some(t => REBOOT_TESTS.includes(t));
    let rebootApplied = false;

    // Apply reboot timeouts if needed
    if (hasReboot) {
        broadcastLog("info", "Reboot tests detected - applying extended timeouts", "playwright");
        broadcast("pipeline", { state: "starting", message: "Reboot tests detected - applying extended timeouts (600/650)..." });
        try {
            const octt = new OcttClient(effectiveConfig.octt);
            try { await octt.stopSession(); } catch { /* no session */ }
            await new Promise(r => setTimeout(r, 2000));
            const current = await octt.getConfiguration(configName);
            const updated = { ...current.data.config, ...REBOOT_TIMEOUTS };
            await octt.saveConfiguration(configName, updated);
            rebootApplied = true;
            broadcastLog("info", "Reboot timeouts applied", "playwright");
        } catch (e: any) {
            broadcastLog("warn", `Failed to apply reboot timeouts: ${e.message}. Continuing...`, "playwright");
        }
    }

    // Start OCTT session
    try {
        const octt = new OcttClient(effectiveConfig.octt);
        const result = await octt.startSession(configName);
        broadcastLog("info", `OCTT session started: ${JSON.stringify(result)}`, "playwright");
    } catch (e: any) {
        broadcastLog("error", `OCTT session failed: ${e.message}. Continuing...`, "playwright");
    }

    // Build Playwright command
    const projectRoot = path.resolve(__dirname, "../../..");
    const args = ["test", `"tests/certification_pipeline.spec.ts"`, "--reporter=list"];
    if (testcaseNames?.length > 0) {
        const grep = testcaseNames.map(t => `Execute ${t}`).join("|");
        args.push(`"--grep=${grep}"`);
    }

    const playwrightBin = path.join(projectRoot, "node_modules", ".bin", "playwright.cmd");

    isRunning = true;
    lastResults = [];
    broadcast("pipeline", { state: "starting", message: `Running ${testcaseNames?.length || "all"} tests...` });

    playwrightProcess = spawn(playwrightBin, args, {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        env: {
            ...process.env,
            OCTT_BASE_URL: effectiveConfig.octt.baseUrl,
            OCTT_TOKEN: effectiveConfig.octt.token,
            OCTT_CONFIG: configName,
            CDS_IP: effectiveConfig.cds.ip,
            CDS_PORT: String(effectiveConfig.cds.port),
        },
    });

    // Parse stdout
    const pendingVerdicts: { verdict: string; duration: number }[] = [];

    playwrightProcess.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(l => l.trim());
        for (const line of lines) {
            broadcastLog("info", line.trim(), "playwright");

            const verdictMatch = line.match(/→\s+(PASS|FAIL|ERROR|INCONC)\s+\((\d+)s\)/);
            if (verdictMatch) {
                pendingVerdicts.push({ verdict: verdictMatch[1].toLowerCase(), duration: parseInt(verdictMatch[2]) });
                continue;
            }

            const passMatch = line.match(/ok\s+\d+.*›.*Execute\s+(\S+)/);
            const failMatch = line.match(/(?:x|✘|✗|not ok)\s+\d+.*›.*Execute\s+(\S+)/);

            if (passMatch || failMatch) {
                const tc = (passMatch || failMatch)![1];
                let verdict = failMatch ? "fail" : "pass";
                let duration = 0;
                if (pendingVerdicts.length > 0) {
                    const pending = pendingVerdicts.shift()!;
                    verdict = pending.verdict;
                    duration = pending.duration;
                }
                lastResults.push({ testCase: tc, verdict, duration });
                broadcast("pipeline", { state: "testing", message: `${verdict.toUpperCase()}: ${tc}`, results: [...lastResults] });
            }
        }
    });

    playwrightProcess.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) broadcastLog("warn", msg, "playwright");
    });

    // Handle exit
    playwrightProcess.on("exit", async (code) => {
        const passCount = lastResults.filter(r => r.verdict === "pass").length;
        const failCount = lastResults.filter(r => r.verdict === "fail").length;
        const total = lastResults.length;

        // Stop session
        try {
            const octt = new OcttClient(effectiveConfig.octt);
            await octt.stopSession();
        } catch { /* ignore */ }

        // Restore default timeouts
        if (rebootApplied) {
            try {
                const octt = new OcttClient(effectiveConfig.octt);
                const current = await octt.getConfiguration(configName);
                const updated = { ...current.data.config, ...DEFAULT_TIMEOUTS };
                await octt.saveConfiguration(configName, updated);
                broadcastLog("info", "Default timeouts restored", "playwright");
            } catch (e: any) {
                broadcastLog("warn", `Failed to restore timeouts: ${e.message}`, "playwright");
            }
        }

        broadcast("pipeline", {
            state: total > 0 ? "done" : "error",
            message: `Complete: ${passCount} pass, ${failCount} fail (${total} total)`,
            results: lastResults,
        });

        isRunning = false;
        playwrightProcess = null;
    });

    playwrightProcess.on("error", (err) => {
        broadcastLog("error", `Playwright error: ${err.message}`, "playwright");
        broadcast("pipeline", { state: "error", message: `Playwright error: ${err.message}` });
        isRunning = false;
        playwrightProcess = null;
    });

    return { ok: true };
}

export function stopPlaywright(): void {
    if (playwrightProcess) {
        playwrightProcess.kill("SIGTERM");
        isRunning = false;
        playwrightProcess = null;
    }
}
