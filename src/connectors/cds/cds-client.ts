// ══════════════════════════════════════════════════════════════
// CDS Client — SLEP TCP protocol client
// Adapted from e2e-automation-controller/src/cds.ts (CdsClientV2)
// ══════════════════════════════════════════════════════════════

import { Socket } from "net";
import { ReplaySubject, BehaviorSubject, Subscription, interval, firstValueFrom } from "rxjs";
import { filter, map, take, takeUntil, timeout, catchError } from "rxjs/operators";
import { of } from "rxjs";
import {
    PidList, CdsControl, CdsStatus, Specification, ChargeMode,
    pidDescription, parafaultDescriptions,
    type DataType, type PidResponse, type MultiPidResponse,
    type CdsConfig, type EvConfig, type EvConfigAc,
} from "./types.js";

type WritePidEntry = { pid: number; dataType: DataType; value: number };

export class CdsClient {
    public readonly responseData = new ReplaySubject<Buffer>(1);
    public readonly statusValue = new BehaviorSubject<number>(0);
    public statusLogging = false;
    public isConnected = false;

    private socket: Socket;
    private statusPollingSubscription?: Subscription;
    private statusSubscription?: Subscription;
    private readonly disconnect$ = new ReplaySubject<void>(1);

    constructor(
        public readonly ip: string,
        public readonly port: number = 51001
    ) {
        this.socket = new Socket();
    }

    // ── Connection ──

    async connect(): Promise<boolean> {
        if (this.isConnected) return true;

        return new Promise<boolean>((resolve) => {
            this.socket.connect(this.port, this.ip, () => {
                this.isConnected = true;

                // Poll status every second
                this.statusPollingSubscription?.unsubscribe();
                this.statusPollingSubscription = interval(1000)
                    .pipe(takeUntil(this.disconnect$))
                    .subscribe(() => this.requestSinglePid(PidList.Status));

                // Parse status updates
                this.statusSubscription?.unsubscribe();
                this.statusSubscription = this.responseData
                    .pipe(
                        filter((data: Buffer) => data.length <= 16),
                        map((data: Buffer) => this.parseSinglePidResponse(data)),
                        filter((resp) => resp.pid === PidList.Status && resp.type === "GET_RESPONSE"),
                        map((resp) => resp.value ?? 0),
                        takeUntil(this.disconnect$)
                    )
                    .subscribe((value) => {
                        this.statusValue.next(value);
                        if (this.statusLogging) console.log("[CDS] status:", value);
                    });

                resolve(true);
            });

            this.socket.on("error", () => {
                this.isConnected = false;
                resolve(false);
            });

            this.socket.on("close", () => {
                this.isConnected = false;
            });

            this.socket.on("data", (data) => {
                this.responseData.next(data);
            });
        });
    }

    async disconnect(): Promise<boolean> {
        return new Promise((resolve) => {
            this.socket.on("close", () => resolve(true));
            this.socket.on("end", () => resolve(true));
            this.disconnect$.next();
            this.socket.destroy();
            this.isConnected = false;
        });
    }

    // ── Low-level SLEP protocol ──

    private sendCommand(buffer: Buffer): void {
        this.socket.write(Uint8Array.from(buffer));
    }

    requestSinglePid(pid: number): void {
        const header = Buffer.from([0x53, 0x4c, 0x45, 0x50, 0x0c, 0x00, 0x01, 0x01]);
        const pidBuffer = Buffer.alloc(2);
        pidBuffer.writeUInt16LE(pid, 0);
        const reserved = Buffer.from([0x00, 0x00]);
        this.sendCommand(Buffer.concat([header, pidBuffer, reserved]));
    }

    writeSinglePid(pid: number, dataType: DataType, value: number): void {
        const header = Buffer.from([0x53, 0x4c, 0x45, 0x50, 0x10, 0x00, 0x01, 0x03]);
        const pidBuffer = Buffer.alloc(2);
        pidBuffer.writeUInt16LE(pid, 0);
        const reservedAndType = Buffer.from([0x00, dataType === "int32" ? 0x01 : 0x02]);
        const valueBuffer = Buffer.alloc(4);
        if (dataType === "int32") valueBuffer.writeInt32LE(value, 0);
        else valueBuffer.writeFloatLE(value, 0);
        this.sendCommand(Buffer.concat([header, pidBuffer, reservedAndType, valueBuffer]));
    }

    writeMultiplePids(pids: WritePidEntry[]): void {
        const header = Buffer.from([0x53, 0x4c, 0x45, 0x50, 0x00, 0x00, 0x01, 0x05]);
        const reserved = Buffer.alloc(4);
        const tuples = Buffer.concat(
            pids.map(({ pid, dataType, value }) => {
                const buf = Buffer.alloc(8);
                buf.writeUInt8(0x02, 0);
                buf.writeUInt8(dataType === "int32" ? 0x01 : 0x02, 1);
                buf.writeUInt16LE(pid, 2);
                if (dataType === "int32") buf.writeInt32LE(value, 4);
                else buf.writeFloatLE(value, 4);
                return buf;
            })
        );
        const totalLength = header.length + reserved.length + tuples.length;
        header.writeUInt16LE(totalLength, 4);
        this.sendCommand(Buffer.concat([header, reserved, tuples]));
    }

    parseSinglePidResponse(data: Buffer): PidResponse {
        const pid = data.readUInt16LE(8);
        const parafault = data.readUInt8(10);
        const name = pidDescription[pid] ?? "Unknown";

        if (data.length === 16) {
            const dataTypeCode = data.readUInt8(11);
            const valueBuffer = data.subarray(12, 16);
            let dataType: "int32" | "float" | "void" = "void";
            let value: number | null = null;

            if (dataTypeCode === 0x01) { dataType = "int32"; value = valueBuffer.readInt32LE(0); }
            else if (dataTypeCode === 0x02) { dataType = "float"; value = valueBuffer.readFloatLE(0); }

            const sendError = parafault !== 0 ? parafaultDescriptions[parafault] ?? "Unknown error" : undefined;
            return { pid, name, dataType, value, parafault, sendError, type: "GET_RESPONSE" };
        } else if (data.length === 12) {
            const sendError = parafault !== 0 ? parafaultDescriptions[parafault] ?? "Unknown error" : undefined;
            return { pid, name, parafault, sendError, type: "SET_RESPONSE" };
        }

        throw new Error(`Unknown response format: length=${data.length}`);
    }

    parseMultiResponse(data: Buffer): MultiPidResponse[] {
        const results: MultiPidResponse[] = [];
        const count = (data.length - 12) / 8;
        let hasValues = false;

        for (let i = 0; i < count; i++) {
            const offset = 12 + i * 8;
            const parafault = data.readUInt8(offset);
            const dataTypeCode = data.readUInt8(offset + 1);
            const pid = data.readUInt16LE(offset + 2);
            const name = pidDescription[pid] ?? "Unknown";
            const valueBuffer = data.subarray(offset + 4, offset + 8);

            let dataType: "int32" | "float" | "void" = "void";
            let value: number | null = null;

            if (dataTypeCode === 0x01) { dataType = "int32"; value = valueBuffer.readInt32LE(0); hasValues = true; }
            else if (dataTypeCode === 0x02) { dataType = "float"; value = valueBuffer.readFloatLE(0); hasValues = true; }

            results.push({
                pid, name, dataType, value, parafault,
                sendError: parafault !== 0 ? parafaultDescriptions[parafault] ?? "Unknown error" : undefined,
                type: hasValues ? "GET_MULTIRESPONSE" : "SET_MULTIRESPONSE",
            });
        }
        return results;
    }

    // ── High-level operations ──

    async readPid(pid: number, timeoutMs = 2000): Promise<PidResponse | null> {
        return new Promise((resolve) => {
            let sub: Subscription;
            const timer = setTimeout(() => { sub?.unsubscribe(); resolve(null); }, timeoutMs);

            sub = this.responseData
                .pipe(filter((data: Buffer) => data.length === 16))
                .subscribe((data: Buffer) => {
                    const resp = this.parseSinglePidResponse(data);
                    if (resp.pid === pid) {
                        clearTimeout(timer);
                        sub.unsubscribe();
                        resolve(resp);
                    }
                });

            this.requestSinglePid(pid);
        });
    }

    async waitForStatus(target: number, timeoutMs = 5000): Promise<boolean> {
        return firstValueFrom(
            this.statusValue.pipe(
                filter((s) => s === target),
                timeout(timeoutMs),
                map(() => true),
                catchError(() => of(false))
            )
        );
    }

    async waitForStatusBit(bitMask: number, timeoutMs = 5000): Promise<boolean> {
        return firstValueFrom(
            this.statusValue.pipe(
                filter((s) => (s & bitMask) !== 0),
                timeout(timeoutMs),
                map(() => true),
                catchError(() => of(false))
            )
        );
    }

    private calcBattVoltage(max: number, min: number, soc: number): number {
        let result = Math.round((max - min) * (soc / 100) + min);
        if (result >= max) result = max - 1;
        return result;
    }

    private async checkWriteResponse(sendData: WritePidEntry[]): Promise<boolean> {
        return firstValueFrom(
            this.responseData.pipe(
                filter((data: Buffer) => data.length === 12 + 8 * sendData.length),
                map((data: Buffer) => {
                    const resp = this.parseMultiResponse(data);
                    const allPresent = sendData.every((sd) => resp.some((r) => r.pid === sd.pid));
                    return allPresent && resp.every((r) => r.parafault === 0);
                }),
                take(1)
            )
        );
    }

    // ── Lifecycle ──

    async reset(): Promise<boolean> {
        try {
            if (!(await this.waitForStatus(CdsStatus.Stopped, 2000)) && !(await this.waitForStatus(CdsStatus.ErrorPending, 2000))) {
                this.writeSinglePid(PidList.Control, "int32", CdsControl.Stop);
                await this.waitForStatus(CdsStatus.Stopped, 20000);
            }

            const sub = this.responseData.pipe(filter((d: Buffer) => d.length === 12)).subscribe((data) => {
                const resp = this.parseSinglePidResponse(data);
                if (resp.pid === PidList.Control) {
                    this.writeSinglePid(PidList.Control, "int32", CdsControl.Reset);
                    sub.unsubscribe();
                }
            });

            await this.waitForStatusBit(CdsStatus.Stopped, 500);
            this.writeSinglePid(PidList.Control, "int32", CdsControl.Initializing);
            await this.waitForStatusBit(CdsStatus.Resetting, 2000);
            return await this.waitForStatus(CdsStatus.Stopped, 15000);
        } catch {
            return false;
        }
    }

    async start(): Promise<boolean> {
        this.writeSinglePid(PidList.Control, "int32", CdsControl.Start);
        return this.waitForStatus(CdsStatus.Running, 5000);
    }

    async stop(): Promise<boolean> {
        this.writeSinglePid(PidList.Control, "int32", CdsControl.Stop);
        return this.waitForStatus(CdsStatus.Stopped, 20000);
    }

    async emergencyStop(): Promise<void> {
        this.writeSinglePid(PidList.Control, "int32", CdsControl.EmergencyOff);
    }

    // ── Configuration ──

    async configureCds(config: CdsConfig): Promise<boolean> {
        const { specification, chargeMode, sinkId, mode = 2 } = config;
        const sendData: WritePidEntry[] = [
            { pid: PidList.Specification, dataType: "int32", value: specification },
            { pid: PidList.ChargeMode, dataType: "int32", value: chargeMode },
            { pid: PidList.Sink, dataType: "int32", value: sinkId },
            { pid: PidList.Mode, dataType: "int32", value: mode },
            { pid: PidList.EVChargingModel, dataType: "int32", value: 1 },
        ];
        this.writeMultiplePids(sendData);
        return this.checkWriteResponse(sendData);
    }

    async configureEv(config: EvConfig): Promise<boolean> {
        const {
            SwitchOffLimitVoltage = 1000, SwitchOffLimitCurrent = 600,
            SwitchOffLimitPowerInW = 180000, EVMaximumCurrentLimit = 100,
            EVMaximumVoltageLimit = 500, EVMaximumPowerLimit = 20000,
            EVMinimumCurrentLimit = 0, EVMinimumVoltageLimit = 300,
            EVstateOfCharge = 20, BatteryCapacity = 10000,
        } = config;

        const sendData: WritePidEntry[] = [
            { pid: PidList.PowerSource_Ierr_max, dataType: "float", value: SwitchOffLimitCurrent },
            { pid: PidList.PowerSource_Perr_max, dataType: "float", value: SwitchOffLimitPowerInW },
            { pid: PidList.PowerSource_Uerr_max, dataType: "float", value: SwitchOffLimitVoltage },
            { pid: PidList.EVMaximumCurrentLimit, dataType: "float", value: EVMaximumCurrentLimit },
            { pid: PidList.EVMaximumVoltageLimit, dataType: "float", value: EVMaximumVoltageLimit },
            { pid: PidList.EVMaximumPowerLimit, dataType: "float", value: EVMaximumPowerLimit },
            { pid: PidList.EVMinimumCurrentLimit, dataType: "float", value: EVMinimumCurrentLimit },
            { pid: PidList.EVMinimumVoltageLimit, dataType: "float", value: EVMinimumVoltageLimit },
            { pid: PidList.EVRESSSoC, dataType: "float", value: EVstateOfCharge },
            { pid: PidList.EVEnergyCapacity, dataType: "float", value: BatteryCapacity },
            { pid: PidList.EVBatteryVoltage, dataType: "float", value: this.calcBattVoltage(EVMaximumVoltageLimit, EVMinimumVoltageLimit, EVstateOfCharge) },
        ];
        this.writeMultiplePids(sendData);
        return this.checkWriteResponse(sendData);
    }

    async configureEvAc(config: EvConfigAc): Promise<boolean> {
        const { EVstateOfCharge = 20, BatteryCapacity = 10000 } = config;
        const sendData: WritePidEntry[] = [
            { pid: PidList.EVRESSSoC, dataType: "float", value: EVstateOfCharge },
            { pid: PidList.EVEnergyCapacity, dataType: "float", value: BatteryCapacity },
        ];
        this.writeMultiplePids(sendData);
        return this.checkWriteResponse(sendData);
    }

    // ── Measurements ──

    async readMeasurements(): Promise<{ voltage: number | null; current: number | null; soc: number | null; cpStateRaw: number | null }> {
        const vResp = await this.readPid(PidList.u_dc_act);
        const iResp = await this.readPid(PidList.i_dc_act);
        const socResp = await this.readPid(PidList.EVRESSSoC);
        const cpResp = await this.readPid(PidList.CpStateEvse);
        
        return {
            voltage: vResp?.value ?? null,
            current: iResp?.value ?? null,
            soc: socResp?.value ?? null,
            cpStateRaw: cpResp?.value ?? null,
        };
    }

    getStatusDescription(value: number): string[] {
        const flags: string[] = [];
        if (value === 0) return ["stopped"];
        if (value & CdsStatus.Running) flags.push("running");
        if (value & CdsStatus.ErrorPending) flags.push("error_pending");
        if (value & CdsStatus.ActiveCharging) flags.push("active_charging");
        if (value & CdsStatus.Resetting) flags.push("resetting");
        if (value & CdsStatus.Initializing) flags.push("initializing");
        if (value & CdsStatus.WaitingForUser) flags.push("waiting_for_user");
        if (value & CdsStatus.AcContactorClosed) flags.push("ac_contactor_closed");
        if (value & CdsStatus.DcContactorClosed) flags.push("dc_contactor_closed");
        return flags;
    }
}
