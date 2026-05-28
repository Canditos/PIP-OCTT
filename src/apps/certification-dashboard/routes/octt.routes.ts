// ══════════════════════════════════════════════════════════════
// OCTT Routes — OCA Compliance Testing Tool endpoints
// ══════════════════════════════════════════════════════════════

import { Router } from "express";
import { OcttClient } from "../../../connectors/octt/index.js";
import { log } from "./logs.routes.js";
import { setService } from "../services/service-state.service.js";
import { effectiveConfig } from "../config/dashboard.config.js";
import { validate } from "../middleware/validate.js";
import { octtCheckSchema, octtCheckConfigSchema, octtConfigTimeoutsSchema } from "../schemas/api.schemas.js";

const router = Router();
const { octt: octtCfg } = effectiveConfig;

router.post("/check", validate(octtCheckSchema), async (req, res) => {
    const { baseUrl, token } = req.body;
    setService("octt", "connecting");
    try {
        const cfg = { ...octtCfg, ...(baseUrl ? { baseUrl } : {}), ...(token ? { token } : {}) };
        const octt = new OcttClient(cfg);
        const result = await octt.listConfigurations();
        setService("octt", "connected", `${result.configurations.length} configs`);
        res.json({ ok: true, configurations: result.configurations });
    } catch (e: any) {
        setService("octt", "error", e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/check-config", async (req, res) => {
    const { configurationName, baseUrl, token } = req.body;
    try {
        const cfg = { ...octtCfg, ...(baseUrl ? { baseUrl } : {}), ...(token ? { token } : {}) };
        const octt = new OcttClient(cfg);
        const configs = await octt.listConfigurations();
        const exists = configs.configurations.includes(configurationName);
        res.json({ ok: true, exists, configurations: configs.configurations, testcasesCount: configs.configurations.length, sessionStatus: "unknown" });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/config-timeouts", validate(octtConfigTimeoutsSchema), async (req, res) => {
    const { configurationName, maxTimeoutPeriod, longOperationTimeout } = req.body;
    try {
        const octt = new OcttClient(octtCfg);
        const current = await octt.getConfiguration(configurationName || "AUT_SID_SAT");
        const updated = { ...current.data.config };
        if (maxTimeoutPeriod !== undefined) updated.max_timeout_period = String(maxTimeoutPeriod);
        if (longOperationTimeout !== undefined) updated.long_operation_timeout = String(longOperationTimeout);
        await octt.saveConfiguration(configurationName || "AUT_SID_SAT", updated);
        log("info", `Timeouts updated for ${configurationName || "AUT_SID_SAT"}`, "octt");
        res.json({ ok: true });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/prepare-reboot", async (req, res) => {
    const { configurationName } = req.body;
    try {
        const octt = new OcttClient(octtCfg);
        try { await octt.stopSession(); } catch { /* no session */ }
        await new Promise(r => setTimeout(r, 2000));
        const current = await octt.getConfiguration(configurationName || "AUT_SID_SAT");
        const updated = { ...current.data.config, max_timeout_period: "600", long_operation_timeout: "650" };
        await octt.saveConfiguration(configurationName || "AUT_SID_SAT", updated);
        log("info", `Reboot timeouts applied for ${configurationName || "AUT_SID_SAT"}`, "octt");
        res.json({ ok: true, message: "Reboot timeouts applied (600/650)" });
    } catch (e: any) {
        log("error", `Prepare reboot failed: ${e.message}`, "octt");
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/restore-defaults", async (req, res) => {
    const { configurationName } = req.body;
    try {
        const octt = new OcttClient(octtCfg);
        const current = await octt.getConfiguration(configurationName || "AUT_SID_SAT");
        const updated = { ...current.data.config, max_timeout_period: "70", long_operation_timeout: "450" };
        await octt.saveConfiguration(configurationName || "AUT_SID_SAT", updated);
        log("info", `Default timeouts restored for ${configurationName || "AUT_SID_SAT"}`, "octt");
        res.json({ ok: true, message: "Default timeouts restored (70/450)" });
    } catch (e: any) {
        log("error", `Restore defaults failed: ${e.message}`, "octt");
        res.status(500).json({ ok: false, error: e.message });
    }
});

export default router;
