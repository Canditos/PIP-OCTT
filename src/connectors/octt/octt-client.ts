// ══════════════════════════════════════════════════════════════
// OCTT API Client — adapted from octt-api-main/src/
// Unified client combining all modules into a single class
// ══════════════════════════════════════════════════════════════

import { HttpClient } from "./http-client.js";
import type {
    OcttApiOptions,
    GetConfigurationsResponse,
    GetConfigurationResponse,
    MessageResponse,
    ResponseMessageResponse,
    GetReportsResponse,
    GetReportsFilter,
    DownloadReportsFilter,
    GetCommentResponse,
    SutConnectionStatus,
    GetTestCasesResponse,
    ExecuteTestCaseResponse,
    GetOcppVersionsResponse,
} from "./types.js";

export class OcttClient {
    private readonly client: HttpClient;
    private readonly versionedPath: string;

    constructor(private readonly options: OcttApiOptions) {
        const baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.client = new HttpClient(`${baseUrl}/api/v1`, options.token);
        this.versionedPath = `/${options.ocppVersion}/${options.role}`;
    }

    // ── Configurations ──

    async listConfigurations(): Promise<GetConfigurationsResponse> {
        return this.client.request("GET", `${this.versionedPath}/configurations`);
    }

    async getConfiguration(name: string): Promise<GetConfigurationResponse> {
        return this.client.request("GET", `${this.versionedPath}/configurations/${encodeURIComponent(name)}`);
    }

    async saveConfiguration(name: string, data: Record<string, unknown>): Promise<MessageResponse> {
        return this.client.request("PUT", `${this.versionedPath}/configurations/${encodeURIComponent(name)}`, {
            body: data,
        });
    }

    async deleteConfiguration(name: string): Promise<MessageResponse> {
        return this.client.request("DELETE", `${this.versionedPath}/configurations/${encodeURIComponent(name)}`);
    }

    // ── Sessions ──

    async startSession(configurationName: string): Promise<MessageResponse> {
        return this.client.request("POST", `${this.versionedPath}/session/start/${encodeURIComponent(configurationName)}`);
    }

    async stopSession(): Promise<MessageResponse> {
        return this.client.request("POST", "/session/stop");
    }

    // ── Test Execution ──

    async listTestCases(configurationName: string): Promise<GetTestCasesResponse> {
        return this.client.request("GET", `${this.versionedPath}/testcases/${encodeURIComponent(configurationName)}`);
    }

    async executeTestCase(testcaseName: string): Promise<ExecuteTestCaseResponse> {
        return this.client.request("POST", `/testcases/${encodeURIComponent(testcaseName)}/execute`);
    }

    async stopTestCase(): Promise<MessageResponse> {
        return this.client.request("GET", "/testcases/stop");
    }

    // ── Reports ──

    async getReports(params?: { configuration_name?: string; testcase_name?: string }): Promise<GetReportsResponse> {
        return this.client.request("GET", `${this.versionedPath}/reports`, {
            params: params as Record<string, string>,
        });
    }

    async getReportsFiltered(filter: GetReportsFilter): Promise<GetReportsResponse> {
        return this.client.request("POST", `${this.versionedPath}/reports`, { body: filter });
    }

    async downloadReports(params: { format: string; configuration_name?: string; logfile_name?: string }): Promise<Buffer> {
        const queryParams: Record<string, string> = { format: params.format };
        if (params.logfile_name) queryParams.logfile_name = params.logfile_name;
        if (params.configuration_name) queryParams.configuration_name = params.configuration_name;

        return this.client.request("GET", `${this.versionedPath}/reports/download`, {
            params: queryParams,
            responseType: "arraybuffer",
        });
    }

    async downloadReportsFiltered(filter: DownloadReportsFilter): Promise<Buffer> {
        return this.client.request("POST", `${this.versionedPath}/reports/download`, {
            body: filter,
            responseType: "arraybuffer",
        });
    }

    // ── Comments ──

    async getComment(configurationName: string, logfileName: string): Promise<GetCommentResponse> {
        return this.client.request("GET", `${this.versionedPath}/reports/${encodeURIComponent(configurationName)}/comment`, {
            params: { logfile_name: logfileName },
        });
    }

    async addComment(configurationName: string, logfileName: string, comment: string): Promise<ResponseMessageResponse> {
        const params = new URLSearchParams();
        params.append("comment", comment);

        return this.client.request("PUT", `${this.versionedPath}/reports/${encodeURIComponent(configurationName)}/comment`, {
            body: params.toString(),
            contentType: "application/x-www-form-urlencoded",
            params: { logfile_name: logfileName },
        });
    }

    // ── SUT Status ──

    async getSutStatus(): Promise<SutConnectionStatus> {
        return this.client.request("GET", "/sut_connection_status");
    }

    // ── OCPP Versions ──

    async listOcppVersions(): Promise<GetOcppVersionsResponse> {
        return this.client.request("GET", "/ocpp_versions");
    }
}
