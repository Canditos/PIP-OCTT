import { Router } from "express";
import { getLastResults, getRunHistory, clearRunHistory, clearLastResults } from "../services/pipeline.service.js";

const router = Router();

router.get("/", (_req, res) => {
    const results = getLastResults();
    res.json({ results, total: results.length });
});

// ── Run History ──

router.get("/history", (_req, res) => {
    const history = getRunHistory();
    res.json(history);
});

router.post("/history/clear", (_req, res) => {
    clearRunHistory();
    res.json({ ok: true });
});

router.post("/reset", (_req, res) => {
    clearLastResults();
    res.json({ ok: true });
});

export default router;
