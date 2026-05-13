// ══════════════════════════════════════════════════════════════
// OCTT HTTP Client — adapted from octt-api-main/src/client.ts
// ══════════════════════════════════════════════════════════════

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, type Method } from "axios";

export class OcttApiError extends Error {
    public readonly statusCode?: number;
    public readonly errorCode: string;
    public readonly requestUrl?: string;

    constructor(message: string, options: { statusCode?: number; errorCode: string; requestUrl?: string; cause?: Error }) {
        super(message);
        this.name = "OcttApiError";
        this.statusCode = options.statusCode;
        this.errorCode = options.errorCode;
        this.requestUrl = options.requestUrl;
    }
}

export interface RequestOptions {
    body?: unknown;
    contentType?: string;
    params?: Record<string, string>;
    responseType?: "json" | "arraybuffer" | "stream";
}

export class HttpClient {
    private readonly axios: AxiosInstance;

    constructor(baseURL: string, token: string) {
        this.axios = axios.create({
            baseURL,
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
        });
    }

    async request<T = unknown>(
        method: Method,
        path: string,
        options: RequestOptions = {}
    ): Promise<T> {
        const { body, contentType, params, responseType = "json" } = options;

        const config: AxiosRequestConfig = {
            method,
            url: path,
            params,
            responseType,
        };

        if (responseType === "arraybuffer" || responseType === "stream") {
            config.headers = { ...config.headers, Accept: "application/octet-stream" };
        }

        if (body !== undefined && body !== null) {
            if (typeof body === "string" || Buffer.isBuffer(body)) {
                config.data = body;
                config.headers = { ...config.headers, "Content-Type": contentType ?? "application/octet-stream" };
            } else {
                config.data = body;
                config.headers = { ...config.headers, "Content-Type": contentType ?? "application/json" };
            }
        }

        try {
            const response = await this.axios.request<T>(config);
            return response.data;
        } catch (error) {
            if (error instanceof AxiosError) {
                const url = `${config.url}`;

                if (error.code === "ENOTFOUND") {
                    throw new OcttApiError(
                        `Server not reachable: hostname could not be resolved`,
                        { errorCode: "ENOTFOUND", requestUrl: url, cause: error }
                    );
                }

                if (error.code === "ECONNREFUSED") {
                    throw new OcttApiError(
                        `Connection refused by server`,
                        { errorCode: "ECONNREFUSED", requestUrl: url, cause: error }
                    );
                }

                if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
                    throw new OcttApiError(
                        `Request timed out`,
                        { errorCode: error.code, requestUrl: url, cause: error }
                    );
                }

                if (error.response) {
                    const status = error.response.status;
                    const data = error.response.data;
                    const detail = typeof data === "object" && data !== null && "message" in data
                        ? (data as { message: string }).message
                        : JSON.stringify(data);

                    throw new OcttApiError(
                        `Request failed with status ${status}: ${detail}`,
                        { statusCode: status, errorCode: `HTTP_${status}`, requestUrl: url, cause: error }
                    );
                }

                throw new OcttApiError(
                    `Request failed: ${error.message}`,
                    { errorCode: error.code ?? "UNKNOWN", requestUrl: url, cause: error }
                );
            }
            throw error;
        }
    }
}
