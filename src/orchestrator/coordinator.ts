// ══════════════════════════════════════════════════════════════
// Orchestrator — End-to-end test execution coordinator
// Wires OCTT, CDS, and Jira together for automated certification
// ══════════════════════════════════════════════════════════════

import { OcttClient } from "../connectors/octt/index.js";
import { CdsClient, Specification, ChargeMode, PidList, type CdsConfig, type EvConfig } from "../connectors/cds/index.js";
import { JiraClient } from "../connectors/jira/index.js";
import { dedup } from "../domain/dedup-engine.js";
import { mapToJiraIssue, mapToJiraComment } from "../domain/jira-mapper.js";
import { summarize, formatSummaryMarkdown } from "../domain/execution-summarizer.js";
import type { ReportEntry } from "../connectors/octt/types.js";

export interface OrchestratorConfig {
    octt: {
        baseUrl: string;
        token: string;
        ocppVersion: string;
        role: "CS" | "CSMS";
    };
    cds: {
        ip: string;
        port: number;
    };
    jira: {
        baseUrl: string;
        email: string;
        apiToken: string;
        projectKey: string;
    };
    cdsConfig: CdsConfig;
    evConfig: EvConfig;
}

export type OrchestratorState =
    | "idle"
    | "connecting"
    | "configuring_lab"
    | "starting_session"
    | "running_tests"
    | "processing_results"
    | "syncing_jira"
    | "generating_summary"
    | "done"
    | "error";

export interface OrchestratorEvent {
    timestamp: string;
    state: OrchestratorState;
    message: string;
    data?: unknown;
}

export class Orchestrator {
    private octt: OcttClient;
    private cds: CdsClient;
    private jira: JiraClient;
    private state: OrchestratorState = "idle";
    private log: OrchestratorEvent[] = [];

    constructor(private config: OrchestratorConfig) {
        this.octt = new OcttClient(config.octt);
        this.cds = new CdsClient(config.cds.ip, config.cds.port);
        this.jira = new JiraClient(config.jira);
    }

    private emit(message: string, data?: unknown): void {
        const event: OrchestratorEvent = {
            timestamp: new Date().toISOString(),
            state: this.state,
            message,
            data,
        };
        this.log.push(event);
        console.log(`[${event.state}] ${event.message}`);
    }

    getLog(): OrchestratorEvent[] {
        return [...this.log];
    }

    getState(): OrchestratorState {
        return this.state;
    }

    // ── Phase 1: Connect & Prepare Lab ──

    async prepareLab(): Promise<boolean> {
        try {
            this.state = "connecting";

            // Connect CDS
            this.emit("Connecting to CDS...");
            const cdsConnected = await this.cds.connect();
            if (!cdsConnected) {
                this.emit("Failed to connect to CDS", { ip: this.config.cds.ip });
                this.state = "error";
                return false;
            }
            this.emit("CDS connected");

            // Check SUT status
            this.emit("Checking SUT connection...");
            const sutStatus = await this.octt.getSutStatus();
            this.emit("SUT status retrieved", sutStatus);

            // Configure CDS
            this.state = "configuring_lab";
            this.emit("Resetting CDS...");
            const resetOk = await this.cds.reset();
            if (!resetOk) {
                this.emit("CDS reset failed");
                this.state = "error";
                return false;
            }
            this.emit("CDS reset complete");

            this.emit("Configuring CDS...");
            const configOk = await this.cds.configureCds(this.config.cdsConfig);
            if (!configOk) {
                this.emit("CDS configuration failed");
                this.state = "error";
                return false;
            }

            this.emit("Configuring EV parameters...");
            const evOk = await this.cds.configureEv(this.config.evConfig);
            if (!evOk) {
                this.emit("EV configuration failed");
                this.state = "error";
                return false;
            }

            this.emit("Lab preparation complete ✅");
            return true;
        } catch (error) {
            this.state = "error";
            this.emit("Lab preparation error", { error: String(error) });
            return false;
        }
    }

    // ── Phase 2: Execute Tests ──

    async executeTests(configurationName: string, testcaseNames?: string[]): Promise<ReportEntry[]> {
        try {
            this.state = "starting_session";
            this.emit(`Starting OCTT session with config: ${configurationName}`);
            await this.octt.startSession(configurationName);

            // Start CDS EV simulation (OCTT manages plugin/plugout via SUT EV API)
            this.emit("Starting CDS EV simulation...");
            const started = await this.cds.start();
            if (!started) {
                this.emit("CDS start failed");
                this.state = "error";
                return [];
            }

            // Get test cases if not specified
            if (!testcaseNames || testcaseNames.length === 0) {
                const testCases = await this.octt.listTestCases(configurationName);
                testcaseNames = testCases.data.testcasesData
                    .flatMap((group) => group.data.map((tc) => tc.testcase_name));
                this.emit(`Found ${testcaseNames.length} test cases`);
            }

            // Execute each test
            this.state = "running_tests";
            const allResults: ReportEntry[] = [];

            for (let i = 0; i < testcaseNames.length; i++) {
                const name = testcaseNames[i];
                this.emit(`[${i + 1}/${testcaseNames.length}] Executing: ${name}`);

                try {
                    const result = await this.octt.executeTestCase(name);
                    if (result.data && result.data.length > 0) {
                        allResults.push(...result.data);
                        const verdict = result.data[0].verdict;
                        this.emit(`  → ${verdict}`, { testcase: name, verdict });
                    }
                } catch (error) {
                    this.emit(`  → Error executing ${name}: ${error}`, { testcase: name, error: String(error) });
                }
            }

            this.emit(`Test execution complete: ${allResults.length} results`);
            return allResults;
        } catch (error) {
            this.state = "error";
            this.emit("Test execution error", { error: String(error) });
            return [];
        }
    }

    // ── Phase 3: Process Results & Sync Jira ──

    async processResults(reports: ReportEntry[]): Promise<{
        created: string[];
        commented: string[];
        reopened: string[];
        summary: string;
    }> {
        const result = { created: [] as string[], commented: [] as string[], reopened: [] as string[], summary: "" };

        try {
            // Filter failures
            const failures = reports.filter(
                (r) => r.verdict.toLowerCase() !== "pass"
            );
            this.emit(`Processing ${failures.length} failures out of ${reports.length} results`);

            this.state = "syncing_jira";

            for (const report of failures) {
                const dedupResult = await dedup(report, this.jira);

                switch (dedupResult.action) {
                    case "create": {
                        const issuePayload = mapToJiraIssue(report);
                        const issue = await this.jira.createIssue(issuePayload);
                        result.created.push(issue.key);
                        this.emit(`Created ${issue.key}: ${issuePayload.summary}`);
                        break;
                    }
                    case "comment": {
                        const key = dedupResult.existingIssue!.key;
                        const comment = mapToJiraComment(report);
                        await this.jira.addComment(key, comment);
                        result.commented.push(key);
                        this.emit(`Commented on ${key}`);
                        break;
                    }
                    case "reopen": {
                        const key = dedupResult.existingIssue!.key;
                        const comment = mapToJiraComment(report);
                        await this.jira.transitionByName(key, "Reopen", comment);
                        result.reopened.push(key);
                        this.emit(`Reopened ${key} (regression)`);
                        break;
                    }
                }
            }

            // Generate summary
            this.state = "generating_summary";
            const summaryData = summarize(reports);
            result.summary = formatSummaryMarkdown(summaryData);
            this.emit("Summary generated", summaryData);

            this.state = "done";
            return result;
        } catch (error) {
            this.state = "error";
            this.emit("Result processing error", { error: String(error) });
            return result;
        }
    }

    // ── Full Pipeline ──

    async run(configurationName: string, testcaseNames?: string[]): Promise<void> {
        this.emit("=== Starting full certification pipeline ===");

        const labOk = await this.prepareLab();
        if (!labOk) {
            this.emit("Pipeline aborted: lab preparation failed");
            return;
        }

        const results = await this.executeTests(configurationName, testcaseNames);
        if (results.length === 0) {
            this.emit("Pipeline aborted: no test results");
            return;
        }

        const processResult = await this.processResults(results);
        this.emit("=== Pipeline complete ===", processResult);
    }

    // ── Cleanup ──

    async cleanup(): Promise<void> {
        try {
            await this.cds.stop();
            this.cds.writeSinglePid(PidList.CpStateEv, "int32", 1);
            await this.cds.disconnect();
            await this.octt.stopSession();
            this.emit("Cleanup complete");
        } catch {
            this.emit("Cleanup error (non-fatal)");
        }
    }
}
