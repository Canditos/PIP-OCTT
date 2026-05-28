// ══════════════════════════════════════════════════════════════
// Config Routes — Dashboard configuration persistence
// ══════════════════════════════════════════════════════════════

import { Router } from "express";
import { currentConfig, updateConfig, effectiveConfig } from "../config/dashboard.config.js";
import { log } from "./logs.routes.js";
import { validate } from "../middleware/validate.js";
import { configSaveSchema } from "../schemas/api.schemas.js";

const router = Router();

router.get("/", (_req, res) => {
    res.json({
        ok: true,
        config: currentConfig,
        effective: {
            octtUrl: effectiveConfig.octt.baseUrl,
            octtToken: effectiveConfig.octt.token ? effectiveConfig.octt.token.slice(0, 8) + "..." : "",
            cdsIp: effectiveConfig.cds.ip,
            cdsPort: effectiveConfig.cds.port,
            jiraProjectKey: effectiveConfig.jira.projectKey,
        },
    });
});

router.post("/", validate(configSaveSchema), (req, res) => {
    try {
        updateConfig(req.body);
        log("info", "Config saved", "dashboard");
        res.json({ ok: true });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

export default router;
