// ══════════════════════════════════════════════════════════════
// Service State — Tracks CDS, OCTT, Jira connection status
// ══════════════════════════════════════════════════════════════

import { broadcast } from "./sse.service.js";

export interface ServiceState {
    status: "disconnected" | "connecting" | "connected" | "running" | "error";
    label: string;
    info: string;
}

const states = new Map<string, ServiceState>([
    ["cds",  { status: "disconnected", label: "CDS",  info: "Keysight SL1040A" }],
    ["octt", { status: "disconnected", label: "OCTT", info: "Compliance Testing Tool" }],
    ["jira", { status: "disconnected", label: "Jira", info: "Issue Tracking" }],
]);

export function setService(service: string, status: ServiceState["status"], info?: string): void {
    const s = states.get(service);
    if (!s) return;
    s.status = status;
    if (info) s.info = info;
    broadcast("status", { service, status, info: s.info });
}

export function getService(service: string): ServiceState | undefined {
    return states.get(service);
}

export function getAllServices(): Record<string, ServiceState> {
    return Object.fromEntries(states);
}
