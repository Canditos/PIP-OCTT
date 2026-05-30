// ══════════════════════════════════════════════════════════════
// Reports Routes — View logs and download reports (v2 - 2026-05-30)
// Uses getReports() + downloadReports() from OcttClient
// ══════════════════════════════════════════════════════════════
console.log("[reports.routes] Module loaded - using getReports/downloadReports");

import { Router } from "express";
import { OcttClient } from "../../../connectors/octt/index.js";
import { effectiveConfig } from "../config/dashboard.config.js";
import { log } from "./logs.routes.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

router.post("/view-log", async (req, res) => {
    const { testcaseName, configurationName } = req.body;
    try {
        const octt = new OcttClient(effectiveConfig.octt);
        const reports = await octt.getReports({ testcase_name: testcaseName, configuration_name: configurationName || "AUT_SID_SAT" });
        if (!reports.data || reports.data.length === 0) {
            res.status(404).json({ ok: false, error: `No reports found for ${testcaseName}` });
            return;
        }
        const latestReport = reports.data[0];
        const logfileName = latestReport.logfile;
        const configName = latestReport.configuration;

        const fileContent = await octt.downloadReports({
            format: "CSV",
            configuration_name: configName,
            logfile_name: logfileName
        });

        res.json({ ok: true, content: fileContent.toString("utf8") });
    } catch (e: any) {
        log("warn", `View log failed: ${e.message}`, "reports");
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/download", async (req, res) => {
    const { testcaseName, format, configurationName } = req.body;
    try {
        const octt = new OcttClient(effectiveConfig.octt);
        const reports = await octt.getReports({ testcase_name: testcaseName, configuration_name: configurationName || "AUT_SID_SAT" });
        if (!reports.data || reports.data.length === 0) {
            res.status(404).json({ ok: false, error: `No reports found for ${testcaseName}` });
            return;
        }
        const latestReport = reports.data[0];
        const logfileName = latestReport.logfile;
        const configName = latestReport.configuration;

        const fileContent = await octt.downloadReports({
            format: format || "CSV",
            configuration_name: configName,
            logfile_name: logfileName
        });

        const filename = `${testcaseName}_Report_${Date.now()}.${(format || "CSV").toLowerCase()}`;
        const reportsDir = path.join(__dirname, "../public/reports");
        if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true });
        }
        const filepath = path.join(reportsDir, filename);
        await fs.promises.writeFile(filepath, fileContent);

        res.json({ ok: true, filename, size: fileContent.length });
    } catch (e: any) {
        log("warn", `Download failed: ${e.message}`, "reports");
        res.status(500).json({ ok: false, error: e.message });
    }
});

export default router;
