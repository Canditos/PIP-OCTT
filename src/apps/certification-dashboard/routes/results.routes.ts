// ══════════════════════════════════════════════════════════════
// Results Routes — Last pipeline results
// ══════════════════════════════════════════════════════════════

import { Router } from "express";
import { getLastResults } from "../services/pipeline.service.js";

const router = Router();

router.get("/", (_req, res) => {
    const results = getLastResults();
    res.json({ results, total: results.length });
});

export default router;
