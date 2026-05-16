// ══════════════════════════════════════════════════════════════
// Rate Limiting Middleware
// ══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
    count: number;
    resetTime: number;
}

const store = new Map<string, RateLimitEntry>();
const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 100; // 100 requests per minute

/**
 * Simple in-memory rate limiter.
 * Limits each IP to 100 requests per minute.
 * 
 * For production, replace with Redis or external service.
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    const entry = store.get(ip);
    if (!entry || now > entry.resetTime) {
        // New window
        store.set(ip, { count: 1, resetTime: now + WINDOW_MS });
        next();
        return;
    }

    if (entry.count >= MAX_REQUESTS) {
        res.status(429).json({
            ok: false,
            error: "Rate limit exceeded. Please try again later.",
            retryAfter: Math.ceil((entry.resetTime - now) / 1000),
        });
        return;
    }

    entry.count++;
    next();
}

// Cleanup old entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of store) {
        if (now > entry.resetTime) {
            store.delete(ip);
        }
    }
}, 300_000);
