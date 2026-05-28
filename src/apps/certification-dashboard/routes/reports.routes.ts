// ══════════════════════════════════════════════════════════════
// Reports Routes — View logs and download reports
// ══════════════════════════════════════════════════════════════

import { Router } from "express";
import { OcttClient } from "../../../connectors/octt/index.js";
import { effectiveConfig } from "../config/dashboard.config.js";
import { log } from "./logs.routes.js";

const router = Router();

router.post("/view-log", async (req, res) => {
    const { testcaseName, configurationName } = req.body;
    try {
        const octt = new OcttClient(effectiveConfig.octt);
        const report = await octt.getReport(configurationName || "AUT_SID_SAT", testcaseName);
        res.json({ ok: true, report });
    } catch (e: any) {
        log("warn", `View log failed: ${e.message}`, "reports");
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/download", async (req, res) => {
    const { testcaseName, format, configurationName } = req.body;
    try {
        const octt = new OcttClient(effectiveConfig.octt);
        const result = await octt.downloadReport(configurationName || "AUT_SID_SAT", testcaseName, format);
        res.json({ ok: true, filename: result.filename, url: result.url });
    } catch (e: any) {
        log("warn", `Download failed: ${e.message}`, "reports");
        res.status(500).json({ ok: false, error: e.message });
    }
});

export default router;
