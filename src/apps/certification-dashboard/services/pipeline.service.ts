import { execFile, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { OcttClient } from "../../../connectors/octt/index.js";
import { log as broadcastLog } from "../routes/logs.routes.js";
import { broadcast } from "./sse.service.js";
import { effectiveConfig } from "../config/dashboard.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HISTORY_FILE = path.resolve(__dirname, "../../../../logs/runs-history.json");

let playwrightProcess: ChildProcess | null = null;
let isRunning = false;
let aborted = false;
let lastResults: any[] = [];
let verdictMap = new Map<string, { verdict: string; duration: number }>();

export function isPlaywrightRunning(): boolean {
    return isRunning;
}

export function getLastResults(): any[] {
    return lastResults;
}

export function clearLastResults(): void {
    lastResults = [];
    verdictMap.clear();
}

const REBOOT_TESTS = ["TC_001_CS", "TC_002_CS", "TC_013_CS", "TC_014_CS", "TC_015_CS", "TC_016_CS", "TC_032_1_CS", "TC_032_2_CS", "TC_034_CS"];
const REBOOT_TIMEOUTS = { max_timeout_period: "600", long_operation_timeout: "650", max_time_deviation: "4" };
const DEFAULT_TIMEOUTS = { max_timeout_period: "70", long_operation_timeout: "450", max_time_deviation: "4" };

export async function runPlaywright(testcaseNames: string[], configName: string): Promise<{ ok: boolean; error?: string }> {
    if (isRunning) return { ok: false, error: "Playwright already running" };
    isRunning = true;
    aborted = false;
    lastResults = [];
    verdictMap.clear();

    const rebootTests = testcaseNames.filter(t => REBOOT_TESTS.includes(t));
    const normalTests = testcaseNames.filter(t => !REBOOT_TESTS.includes(t));

    // Run asynchronously
    (async () => {
        try {
            if (rebootTests.length > 0) {
                broadcast("pipeline", { state: "starting", message: "Phase 1/2: Reboot Tests" });
                await executePhase(rebootTests, configName, true);
            }
            if (normalTests.length > 0 && !aborted) {
                broadcast("pipeline", { state: "starting", message: rebootTests.length > 0 ? "Phase 2/2: Normal Tests" : `Running ${normalTests.length} tests...` });
                await executePhase(normalTests, configName, false);
            }
        } catch (e: any) {
            broadcastLog("error", "Pipeline run error: " + e.message, "pipeline");
        } finally {
            if (!aborted) {
                await finishPipelineRun(configName);
            }
            isRunning = false;
        }
    })();

    return { ok: true };
}

async function executePhase(tests: string[], configName: string, useRebootTimeouts: boolean): Promise<void> {
    if (useRebootTimeouts) {
        broadcastLog("info", "Applying Reboot timeouts (600/650)...", "playwright");
        await applyTimeouts(configName, REBOOT_TIMEOUTS);
    } else {
        broadcastLog("info", "Applying Default timeouts (70/450)...", "playwright");
        await applyTimeouts(configName, DEFAULT_TIMEOUTS);
    }

    try {
        const octt = new OcttClient(effectiveConfig.octt);
        try { await octt.stopSession(); } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 2000));
        const result = await octt.startSession(configName);
        broadcastLog("info", `OCTT session started: ${JSON.stringify(result)}`, "playwright");

        for (let i = 0; i < 30; i++) {
            if (aborted) return;
            await new Promise(r => setTimeout(r, 1000));
            try {
                const status = await octt.getSutStatus();
                if (status.isConnected) {
                    broadcastLog("info", "SUT connected", "playwright");
                    break;
                }
                broadcastLog("info", `Waiting for SUT connection... (${i + 1}s)`, "playwright");
            } catch { /* ignore */ }
        }
    } catch (e: any) {
        broadcastLog("error", `OCTT session failed: ${e.message}`, "playwright");
    }

    return new Promise((resolve) => {
        const projectRoot = path.resolve(__dirname, "../../../..");
        const playwrightCli = path.join(projectRoot, "node_modules", "@playwright", "test", "cli.js");
        const args = ["test", "--reporter=list", "--workers=1"];
        if (tests.length > 0) {
            const grep = tests.map(t => `Execute ${t}`).join("|");
            args.push(`--grep=${grep}`);
        }

        let currentTestId: string | null = null;

        playwrightProcess = execFile(process.execPath, [playwrightCli, ...args], {
            cwd: projectRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                OCTT_BASE_URL: effectiveConfig.octt.baseUrl,
                OCTT_TOKEN: effectiveConfig.octt.token,
                OCTT_CONFIG: configName,
                OCTT_SESSION_STARTED: "true",
                OCTT_MANAGE_SESSION: "true",
                CDS_IP: effectiveConfig.cds.ip,
                CDS_PORT: String(effectiveConfig.cds.port),
            },
        } as any);

        playwrightProcess.stdout?.on("data", (data: Buffer) => {
            const rawLines = data.toString().split("\n").filter(l => l.trim());
            for (const rawLine of rawLines) {
                const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, '');
                broadcastLog("info", line.trim(), "playwright");

                const execMatch = line.match(/\[OCTT\] Executing\s+(\S+)/);
                if (execMatch) {
                    currentTestId = execMatch[1];
                    continue;
                }

                const verdictMatch = line.match(/\s*→\s+(\S+):\s+(PASS|FAIL|ERROR|INCONC)\s+\(([\d.]+)s\)/i);
                if (verdictMatch) {
                    const tcId = verdictMatch[1];
                    const verdict = verdictMatch[2].toLowerCase();
                    const duration = parseFloat(verdictMatch[3]);
                    if (!verdictMap.has(tcId)) verdictMap.set(tcId, { verdict, duration });
                    continue;
                }

                const verdictFallback = line.match(/\s*→\s+(PASS|FAIL|ERROR|INCONC)\s+\(([\d.]+)s\)/i);
                if (verdictFallback && currentTestId) {
                    const verdict = verdictFallback[1].toLowerCase();
                    const duration = parseFloat(verdictFallback[2]);
                    if (!verdictMap.has(currentTestId)) verdictMap.set(currentTestId, { verdict, duration });
                    continue;
                }

                const passMatch = line.match(/(?:ok|✓|✔)\s+\d+.*›.*Execute\s+([^\s(]+)(?:\s+\(([\d.]+)s\))?/);
                const failMatch = line.match(/(?:x|✘|✗|not ok)\s+\d+.*›.*Execute\s+([^\s(]+)(?:\s+\(([\d.]+)s\))?/);

                if (passMatch || failMatch) {
                    const matchObj = passMatch || failMatch;
                    const tcId = matchObj![1];
                    const inlineDurationStr = matchObj![2];
                    
                    const haveVerdict = verdictMap.get(tcId);
                    const verdict = haveVerdict ? haveVerdict.verdict : (failMatch ? "fail" : "pass");
                    let duration = haveVerdict?.duration;
                    if (!duration) duration = inlineDurationStr ? parseFloat(inlineDurationStr) : 0;

                    const existingIdx = lastResults.findIndex(r => r.testCase === tcId);
                    if (existingIdx !== -1) {
                        lastResults[existingIdx] = { testCase: tcId, verdict, duration };
                    } else {
                        lastResults.push({ testCase: tcId, verdict, duration });
                    }

                    broadcast("pipeline", { state: "testing", message: `${verdict.toUpperCase()}: ${tcId}`, results: [...lastResults] });
                }
            }
        });

        playwrightProcess.stderr?.on("data", (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) broadcastLog("warn", msg, "playwright");
        });

        playwrightProcess.on("exit", () => {
            playwrightProcess = null;
            resolve();
        });

        playwrightProcess.on("error", (err) => {
            broadcastLog("error", `Playwright error: ${err.message}`, "playwright");
            playwrightProcess = null;
            resolve();
        });
    });
}

async function applyTimeouts(configName: string, timeouts: any) {
    try {
        const octt = new OcttClient(effectiveConfig.octt);
        const current = await octt.getConfiguration(configName);
        const updated = { ...current.data.config, ...timeouts };
        await octt.saveConfiguration(configName, updated);
    } catch (e: any) {
        broadcastLog("warn", `Failed to apply timeouts: ${e.message}`, "playwright");
    }
}

async function finishPipelineRun(configName: string) {
    const passCount = lastResults.filter(r => r.verdict === "pass").length;
    const failCount = lastResults.filter(r => r.verdict === "fail").length;
    const total = lastResults.length;

    try {
        const octt = new OcttClient(effectiveConfig.octt);
        await octt.stopSession();
    } catch { /* ignore */ }

    // Always ensure default timeouts at the end
    await applyTimeouts(configName, DEFAULT_TIMEOUTS);
    broadcastLog("info", "Pipeline finished. Default timeouts restored.", "playwright");

    if (lastResults.length > 0) saveRunToHistory(configName, lastResults);

    broadcast("pipeline", {
        state: total > 0 ? "done" : "error",
        message: `Complete: ${passCount} pass, ${failCount} fail (${total} total)`,
        results: lastResults,
    });
}

export function stopPlaywright(): void {
    if (playwrightProcess) {
        aborted = true;
        playwrightProcess.kill("SIGTERM");
        isRunning = false;
        playwrightProcess = null;
        broadcast("pipeline", { state: "error", message: "Aborted by user" });
    }
}

// ── Run History Persistence ──

const MAX_HISTORY = 50;

export function getRunHistory(): any[] {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
            return JSON.parse(raw);
        }
    } catch { /* ignore corrupt file */ }
    return [];
}

export function clearRunHistory(): void {
    try {
        fs.writeFileSync(HISTORY_FILE, "[]", "utf-8");
    } catch { /* ignore */ }
}

function saveRunToHistory(configName: string, results: any[]): void {
    try {
        const dir = path.dirname(HISTORY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const history = getRunHistory();
        const pass = results.filter(r => r.verdict === "pass").length;
        const fail = results.filter(r => r.verdict === "fail").length;
        const inconc = results.filter(r => r.verdict === "inconc").length;
        const error = results.filter(r => r.verdict === "error").length;
        const total = results.length;

        const entry = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            timestamp: new Date().toISOString(),
            configName,
            total,
            pass,
            fail,
            inconc,
            error,
            passRate: total > 0 ? Math.round((pass / total) * 100) : 0,
            results,
        };

        history.unshift(entry);
        if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");
    } catch (e: any) {
        broadcastLog("error", `Failed to save run history: ${e.message}`, "dashboard");
    }
}
