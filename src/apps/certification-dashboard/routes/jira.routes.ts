// ══════════════════════════════════════════════════════════════
// Jira Routes — Issue tracking and test execution upload
// ══════════════════════════════════════════════════════════════

import { Router } from "express";
import { JiraClient } from "../../../connectors/jira/index.js";
import { log } from "./logs.routes.js";
import { setService } from "../services/service-state.service.js";
import { effectiveConfig } from "../config/dashboard.config.js";
import { getLastResults } from "../services/pipeline.service.js";
import { validate } from "../middleware/validate.js";
import { jiraUploadSchema } from "../schemas/api.schemas.js";

const router = Router();

router.post("/check", async (_req, res) => {
    try {
        const client = new JiraClient(effectiveConfig.jira);
        await client.search(`project=${effectiveConfig.jira.projectKey}`, undefined, 1);
        setService("jira", "connected", `Project: ${effectiveConfig.jira.projectKey}`);
        res.json({ ok: true, projectKey: effectiveConfig.jira.projectKey });
    } catch (e: any) {
        setService("jira", "error", e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.get("/metadata", async (_req, res) => {
    try {
        const client = new JiraClient(effectiveConfig.jira);
        const metadata = await client.getExecutionMetadata();
        res.json({ ok: true, metadata });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/upload-execution", validate(jiraUploadSchema), async (req, res) => {
    const { sut, firmwareVersion, testPlan, environment } = req.body;

    try {
        const client = new JiraClient(effectiveConfig.jira);
        const results = getLastResults();
        const passed = results.filter(r => r.verdict === "pass").length;
        const failed = results.filter(r => r.verdict === "fail").length;
        const total = results.length;
        const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

        const summary = `[OCPP 1.6] Test Execution — ${sut} | FW ${firmwareVersion} | ${passRate}% pass`;
        const description = [
            `h2. Test Execution Summary`,
            `| *SUT* | ${sut} |`,
            `| *Firmware* | ${firmwareVersion} |`,
            `| *Pass Rate* | ${passRate}% |`,
            `| *Total* | ${total} |`,
            ``,
            `h2. Results`,
            `| *Test* | *Verdict* | *Duration* |`,
            ...results.map(r => `| ${r.testCase} | ${r.verdict} | ${r.duration}s |`),
        ].join("\n");

        const issue = await client.createIssue({
            summary,
            description,
            issueType: "Task",
            priority: failed > 0 ? "High" : "Medium",
            labels: ["ocpp", "certification", "test-execution"],
        });

        log("info", `Created Test Execution ${issue.key}`, "jira");
        res.json({ ok: true, issueKey: issue.key, url: `${effectiveConfig.jira.baseUrl}/browse/${issue.key}` });
    } catch (e: any) {
        log("error", `Jira upload failed: ${e.message}`, "jira");
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/upload", async (req, res) => {
    const { testcase, testplan, testexecution, ocppVersion, chargerNumber, comment } = req.body;
    try {
        const client = new JiraClient(effectiveConfig.jira);
        const summary = `[OCPP ${ocppVersion || "1.6"}] ${testcase} — ${chargerNumber || "N/A"}`;
        const description = [
            `h2. Test Case: ${testcase}`,
            `| *Test Plan* | ${testplan || "N/A"} |`,
            `| *Test Execution* | ${testexecution || "N/A"} |`,
            `| *OCPP Version* | ${ocppVersion || "1.6"} |`,
            `| *Charger Number* | ${chargerNumber || "N/A"} |`,
            ``,
            `h3. Comment`,
            comment || "No comment",
        ].join("\n");

        const issue = await client.createIssue({
            summary,
            description,
            issueType: "Task",
            priority: "Medium",
            labels: ["ocpp", "certification", testcase],
        });

        log("info", `Created issue ${issue.key} for ${testcase}`, "jira");
        res.json({ ok: true, issueKey: issue.key, message: `Created ${issue.key}` });
    } catch (e: any) {
        log("error", `Jira upload failed: ${e.message}`, "jira");
        res.status(500).json({ ok: false, error: e.message });
    }
});

export default router;
