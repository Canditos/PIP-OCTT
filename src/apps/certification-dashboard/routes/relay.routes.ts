// ══════════════════════════════════════════════════════════════
// Relay Routes — SUT API relay agent status
// ══════════════════════════════════════════════════════════════

import { Router } from "express";

const router = Router();

router.post("/status", (_req, res) => {
    res.json({ running: false });
});

export default router;
