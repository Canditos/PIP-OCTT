// ══════════════════════════════════════════════════════════════
// Results Routes — Last pipeline results
// ══════════════════════════════════════════════════════════════

import { Router } from "express";
import { getLastResults } from "../services/pipeline.service.js";

const router = Router();

router.get("/", (_req, res) => {
    res.json(getLastResults());
});

export default router;
