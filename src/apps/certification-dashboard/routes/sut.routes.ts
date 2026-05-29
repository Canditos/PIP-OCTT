// ══════════════════════════════════════════════════════════════
// SUT Routes — System Under Test API (OCTT callbacks)
// ══════════════════════════════════════════════════════════════
//
// OCTT sends plugin/plugout callbacks to this endpoint.
// The dashboard receives them and can trigger CDS actions.
// ══════════════════════════════════════════════════════════════

import { Router } from "express";
import { log } from "./logs.routes.js";
import { broadcast } from "../services/sse.service.js";

const router = Router();

// Store the last SUT event for status display
let lastSutEvent: { action: string; timestamp: string; data: any } | null = null;

router.post("/", (req, res) => {
    const body = req.body;
    const action = body?.action || body?.message || "unknown";
    const timestamp = new Date().toISOString();

    lastSutEvent = { action, timestamp, data: body };

    log("info", `SUT callback: ${action}`, "sut");
    broadcast("sut", { action, timestamp, data: body });

    res.json({ ok: true });
});

router.get("/status", (_req, res) => {
    res.json({ ok: true, lastEvent: lastSutEvent });
});

export default router;
