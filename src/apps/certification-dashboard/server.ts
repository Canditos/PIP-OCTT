// ══════════════════════════════════════════════════════════════
// Certification Dashboard Server — Bootstrap
// ══════════════════════════════════════════════════════════════
//
// Previously a 2000-line monolith. Now delegates to modular routes
// and services for maintainability and testability.
// ══════════════════════════════════════════════════════════════

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// Config
import { effectiveConfig } from "./config/dashboard.config.js";

// Services
import { addClient, removeClient } from "./services/sse.service.js";
import { log } from "./routes/logs.routes.js";

// Middleware
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { rateLimiter } from "./middleware/rate-limiter.js";

// Routes
import statusRoutes from "./routes/status.routes.js";
import logsRoutes from "./routes/logs.routes.js";
import cdsRoutes from "./routes/cds.routes.js";
import octtRoutes from "./routes/octt.routes.js";
import pipelineRoutes from "./routes/pipeline.routes.js";
import jiraRoutes from "./routes/jira.routes.js";
import docsRoutes from "./routes/docs.routes.js";
import relayRoutes from "./routes/relay.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.CERT_DASHBOARD_PORT ?? "3101", 10);

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(rateLimiter);

// ── API Routes ──
app.use("/api/status", statusRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/cds", cdsRoutes);
app.use("/api/octt", octtRoutes);
app.use("/api/pipeline", pipelineRoutes);
app.use("/api/jira", jiraRoutes);
app.use("/api/docs", docsRoutes);
app.use("/api/relay", relayRoutes);

// ── SSE Endpoint ──
app.get("/api/events", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const id = addClient(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

    req.on("close", () => removeClient(id));
});

// ── Static Files ──
app.use(express.static(path.join(__dirname, "public")));

// ── Error Handling (must be last) ──
app.use(notFoundHandler);
app.use(errorHandler);

// ── Start ──
app.listen(PORT, () => {
    console.log(`[Cert Dashboard] http://localhost:${PORT}`);
    log("info", `Dashboard started on port ${PORT}`, "dashboard");
});

// ── Graceful Shutdown ──
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
