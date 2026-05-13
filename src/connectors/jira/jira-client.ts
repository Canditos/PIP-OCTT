// ══════════════════════════════════════════════════════════════
// Jira Client — REST API v3 for Atlassian Cloud
// ══════════════════════════════════════════════════════════════

import axios, { type AxiosInstance } from "axios";

export interface JiraConfig {
    baseUrl: string;
    email: string;
    apiToken: string;
    projectKey: string;
}

export interface JiraIssue {
    id: string;
    key: string;
    fields: Record<string, unknown>;
}

export interface JiraSearchResult {
    issues: JiraIssue[];
    total: number;
    maxResults: number;
    startAt: number;
}

export interface CreateIssueInput {
    summary: string;
    description: string;
    issueType: string;
    priority?: string;
    labels?: string[];
    components?: string[];
    assigneeId?: string;
    customFields?: Record<string, unknown>;
}

export interface TransitionInfo {
    id: string;
    name: string;
    to: { name: string; id: string };
}

export class JiraClient {
    private readonly axios: AxiosInstance;
    private readonly projectKey: string;

    constructor(config: JiraConfig) {
        this.projectKey = config.projectKey;
        const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");

        this.axios = axios.create({
            baseURL: `${config.baseUrl.replace(/\/+$/, "")}/rest/api/3`,
            headers: {
                Authorization: `Basic ${auth}`,
                Accept: "application/json",
                "Content-Type": "application/json",
            },
        });
    }

    // ── Search ──

    async search(jql: string, fields = ["summary", "status", "priority", "labels", "assignee", "created", "updated"], maxResults = 50): Promise<JiraSearchResult> {
        const response = await this.axios.post("/search", {
            jql,
            fields,
            maxResults,
        });
        return response.data;
    }

    async findExistingIssue(testcaseId: string, failureCategory: string): Promise<JiraIssue | null> {
        const jql = `project = "${this.projectKey}" AND summary ~ "${testcaseId}" AND labels = "${failureCategory}" AND status != "Done" ORDER BY created DESC`;
        const result = await this.search(jql, undefined, 1);
        return result.issues.length > 0 ? result.issues[0] : null;
    }

    // ── CRUD ──

    async getIssue(issueKey: string): Promise<JiraIssue> {
        const response = await this.axios.get(`/issue/${issueKey}`);
        return response.data;
    }

    async createIssue(input: CreateIssueInput): Promise<JiraIssue> {
        const fields: Record<string, unknown> = {
            project: { key: this.projectKey },
            summary: input.summary,
            description: {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text: input.description }],
                    },
                ],
            },
            issuetype: { name: input.issueType },
        };

        if (input.priority) fields.priority = { name: input.priority };
        if (input.labels) fields.labels = input.labels;
        if (input.components) fields.components = input.components.map((name) => ({ name }));
        if (input.assigneeId) fields.assignee = { accountId: input.assigneeId };
        if (input.customFields) Object.assign(fields, input.customFields);

        const response = await this.axios.post("/issue", { fields });
        return response.data;
    }

    async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
        await this.axios.put(`/issue/${issueKey}`, { fields });
    }

    // ── Comments ──

    async addComment(issueKey: string, body: string): Promise<void> {
        await this.axios.post(`/issue/${issueKey}/comment`, {
            body: {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text: body }],
                    },
                ],
            },
        });
    }

    // ── Transitions ──

    async getTransitions(issueKey: string): Promise<TransitionInfo[]> {
        const response = await this.axios.get(`/issue/${issueKey}/transitions`);
        return response.data.transitions;
    }

    async transitionIssue(issueKey: string, transitionId: string, comment?: string): Promise<void> {
        const body: Record<string, unknown> = {
            transition: { id: transitionId },
        };

        if (comment) {
            body.update = {
                comment: [
                    {
                        add: {
                            body: {
                                type: "doc",
                                version: 1,
                                content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
                            },
                        },
                    },
                ],
            };
        }

        await this.axios.post(`/issue/${issueKey}/transitions`, body);
    }

    async transitionByName(issueKey: string, transitionName: string, comment?: string): Promise<boolean> {
        const transitions = await this.getTransitions(issueKey);
        const target = transitions.find((t) => t.name.toLowerCase() === transitionName.toLowerCase());
        if (!target) return false;
        await this.transitionIssue(issueKey, target.id, comment);
        return true;
    }

    // ── Attachments ──

    async addAttachment(issueKey: string, filename: string, content: Buffer): Promise<void> {
        const FormData = (await import("form-data")).default;
        const form = new FormData();
        form.append("file", content, { filename });

        await this.axios.post(`/issue/${issueKey}/attachments`, form, {
            headers: {
                ...form.getHeaders(),
                "X-Atlassian-Token": "no-check",
            },
        });
    }
}
