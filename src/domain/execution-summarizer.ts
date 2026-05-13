// ══════════════════════════════════════════════════════════════
// Execution Summarizer — Generates daily/session summaries
// ══════════════════════════════════════════════════════════════

import type { ReportEntry } from "../connectors/octt/types.js";

export interface ExecutionSummary {
    timestamp: string;
    configuration: string;
    ocppVersion: string;
    totalTests: number;
    passed: number;
    failed: number;
    inconclusive: number;
    errors: number;
    passRate: string;
    duration: {
        totalMs: number;
        formatted: string;
    };
    failedTests: { name: string; verdict: string; profile: string }[];
    certificationBlockers: string[];
}

const BLOCKING_PROFILES = ["Core", "Advanced Security", "Smart Charging"];

/**
 * Produces a structured summary from a batch of OCTT test reports.
 */
export function summarize(reports: ReportEntry[]): ExecutionSummary {
    if (reports.length === 0) {
        return {
            timestamp: new Date().toISOString(),
            configuration: "N/A",
            ocppVersion: "N/A",
            totalTests: 0,
            passed: 0,
            failed: 0,
            inconclusive: 0,
            errors: 0,
            passRate: "0%",
            duration: { totalMs: 0, formatted: "0s" },
            failedTests: [],
            certificationBlockers: [],
        };
    }

    const passed = reports.filter((r) => r.verdict.toLowerCase() === "pass").length;
    const failed = reports.filter((r) => r.verdict.toLowerCase() === "fail").length;
    const inconclusive = reports.filter((r) => r.verdict.toLowerCase() === "inconc").length;
    const errors = reports.filter((r) => r.verdict.toLowerCase() === "error").length;
    const totalMs = reports.reduce((sum, r) => sum + r.duration, 0);

    const failedTests = reports
        .filter((r) => r.verdict.toLowerCase() !== "pass")
        .map((r) => ({
            name: r.testCaseName,
            verdict: r.verdict,
            profile: r.category.replace(/[\[\]]/g, ""),
        }));

    const certificationBlockers = failedTests
        .filter((t) => BLOCKING_PROFILES.some((p) => t.profile.includes(p)))
        .map((t) => `${t.name} (${t.verdict}) — blocks [${t.profile}]`);

    return {
        timestamp: new Date().toISOString(),
        configuration: reports[0].configuration,
        ocppVersion: reports[0].ocppVersion,
        totalTests: reports.length,
        passed,
        failed,
        inconclusive,
        errors,
        passRate: `${((passed / reports.length) * 100).toFixed(1)}%`,
        duration: {
            totalMs,
            formatted: formatDuration(totalMs),
        },
        failedTests,
        certificationBlockers,
    };
}

/**
 * Formats a summary into a human-readable markdown report.
 */
export function formatSummaryMarkdown(summary: ExecutionSummary): string {
    const lines = [
        `# Execution Summary — ${summary.timestamp}`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Configuration | ${summary.configuration} |`,
        `| OCPP Version | ${summary.ocppVersion} |`,
        `| Total Tests | ${summary.totalTests} |`,
        `| ✅ Passed | ${summary.passed} |`,
        `| ❌ Failed | ${summary.failed} |`,
        `| ⚠️ Inconclusive | ${summary.inconclusive} |`,
        `| 🔴 Errors | ${summary.errors} |`,
        `| Pass Rate | **${summary.passRate}** |`,
        `| Duration | ${summary.duration.formatted} |`,
    ];

    if (summary.certificationBlockers.length > 0) {
        lines.push(``, `## 🚨 Certification Blockers`);
        summary.certificationBlockers.forEach((b) => lines.push(`- ${b}`));
    }

    if (summary.failedTests.length > 0) {
        lines.push(``, `## Failed Tests`);
        lines.push(`| Test Case | Verdict | Profile |`);
        lines.push(`|-----------|---------|---------|`);
        summary.failedTests.forEach((t) =>
            lines.push(`| ${t.name} | ${t.verdict} | ${t.profile} |`)
        );
    }

    return lines.join("\n");
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}
