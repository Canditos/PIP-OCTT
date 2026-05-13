// ══════════════════════════════════════════════════════════════
// Dedup Engine — Detects if a failure already has an open Jira issue
// ══════════════════════════════════════════════════════════════

import type { ReportEntry } from "../connectors/octt/types.js";
import type { JiraClient, JiraIssue } from "../connectors/jira/index.js";

export type DedupAction = "create" | "comment" | "reopen";

export interface DedupResult {
    action: DedupAction;
    existingIssue: JiraIssue | null;
    fingerprint: string;
    reason: string;
}

/**
 * Generates a dedup fingerprint from a test result.
 * Two failures match if they have the same testcase + verdict + category.
 */
export function generateFingerprint(report: ReportEntry): string {
    return `${report.testCaseName}::${report.verdict}::${report.category}::${report.configuration}`;
}

/**
 * Determines if a new Jira issue should be created, or if an existing one
 * should be commented/reopened.
 */
export async function dedup(
    report: ReportEntry,
    jira: JiraClient
): Promise<DedupResult> {
    const fingerprint = generateFingerprint(report);

    // Search for existing open issue with same test case
    const existing = await jira.findExistingIssue(
        report.testCaseName,
        classifyFailureCategory(report.verdict)
    );

    if (!existing) {
        return {
            action: "create",
            existingIssue: null,
            fingerprint,
            reason: "No existing issue found for this test case",
        };
    }

    // Check if the existing issue is closed/done
    const status = (existing.fields.status as { name: string })?.name?.toLowerCase();

    if (status === "done" || status === "closed" || status === "resolved") {
        return {
            action: "reopen",
            existingIssue: existing,
            fingerprint,
            reason: `Issue ${existing.key} was ${status} but failure reappeared (regression)`,
        };
    }

    return {
        action: "comment",
        existingIssue: existing,
        fingerprint,
        reason: `Issue ${existing.key} already open — adding new occurrence`,
    };
}

function classifyFailureCategory(verdict: string): string {
    switch (verdict.toLowerCase()) {
        case "error": return "test-error";
        case "inconc": return "inconclusive";
        case "fail": return "test-fail";
        default: return "unknown";
    }
}
