// ══════════════════════════════════════════════════════════════
// Relay Routes — SUT API relay agent status + CDS proxy
// ══════════════════════════════════════════════════════════════

import { Router } from "express";
import { CdsClient } from "../../../connectors/cds/cds-client.js";
import { log } from "./logs.routes.js";

const router = Router();

router.post("/status", (_req, res) => {
    res.json({ running: false });
});

/**
 * POST /i/:cdsId/stop — Stop CDS simulation
 * POST /i/:cdsId/reset — Full CDS reset cycle
 * POST /i/:cdsId/start — Start CDS simulation
 *
 * cdsId format: cds-{ip}-{port}  (e.g. cds-192-168-100-10-51001)
 */
function parseCdsId(cdsId: string): { ip: string; port: number } | null {
    const match = cdsId.match(/^cds-([\d.]+)-(\d+)$/);
    if (!match) return null;
    return { ip: match[1], port: parseInt(match[2], 10) };
}

router.post("/i/:cdsId/stop", async (req, res) => {
    const info = parseCdsId(req.params.cdsId);
    if (!info) {
        res.status(400).json({ error: "Invalid CDS ID format" });
        return;
    }
    log("info", `CDS stop relay to ${info.ip}:${info.port}`, "relay");
    const cds = new CdsClient(info.ip, info.port);
    const connected = await cds.connect();
    if (!connected) {
        res.status(502).json({ error: "Cannot connect to CDS" });
        return;
    }
    const ok = await cds.stop();
    await cds.disconnect();
    res.json({ ok });
});

router.post("/i/:cdsId/reset", async (req, res) => {
    const info = parseCdsId(req.params.cdsId);
    if (!info) {
        res.status(400).json({ error: "Invalid CDS ID format" });
        return;
    }
    log("info", `CDS reset relay to ${info.ip}:${info.port}`, "relay");
    const cds = new CdsClient(info.ip, info.port);
    const connected = await cds.connect();
    if (!connected) {
        res.status(502).json({ error: "Cannot connect to CDS" });
        return;
    }
    const ok = await cds.reset();
    await cds.disconnect();
    res.json({ ok });
});

router.post("/i/:cdsId/start", async (req, res) => {
    const info = parseCdsId(req.params.cdsId);
    if (!info) {
        res.status(400).json({ error: "Invalid CDS ID format" });
        return;
    }
    log("info", `CDS start relay to ${info.ip}:${info.port}`, "relay");
    const cds = new CdsClient(info.ip, info.port);
    const connected = await cds.connect();
    if (!connected) {
        res.status(502).json({ error: "Cannot connect to CDS" });
        return;
    }
    const ok = await cds.start();
    await cds.disconnect();
    res.json({ ok });
});

export default router;
