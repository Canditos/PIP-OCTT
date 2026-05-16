// ══════════════════════════════════════════════════════════════
// Config Encryption — AES-256-GCM for sensitive fields
// ══════════════════════════════════════════════════════════════
//
// Uses a machine-specific key derived from the hostname.
// Not military-grade, but prevents casual credential theft
// from reading dashboard-config.json directly.
// ══════════════════════════════════════════════════════════════

import crypto from "crypto";
import { hostname } from "os";

const ALGORITHM = "aes-256-gcm";
const SENSITIVE_FIELDS = ["octtToken", "jiraApiToken", "jiraEmail"] as const;

/**
 * Derives a 32-byte key from the machine hostname.
 * Same machine always produces the same key.
 */
function deriveKey(): Buffer {
    const salt = process.env.CONFIG_SALT || crypto.createHash("sha256").update(hostname() + "-ocpp-dashboard").digest("hex");
    return crypto.scryptSync(salt, "ocpp-cert-v1", 32);
}

/**
 * Encrypt a single string value.
 * Returns "enc:iv:tag:ciphertext" or the original if falsy.
 */
function encryptValue(value: string): string {
    if (!value) return value;
    const key = deriveKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a single string value.
 * Returns original if not encrypted or falsy.
 */
function decryptValue(value: string): string {
    if (!value || !value.startsWith("enc:")) return value;
    try {
        const key = deriveKey();
        const parts = value.slice(4).split(":");
        if (parts.length !== 3) return value;
        const iv = Buffer.from(parts[0], "hex");
        const tag = Buffer.from(parts[1], "hex");
        const encrypted = Buffer.from(parts[2], "hex");
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
        return value; // Corrupted or wrong key — return as-is
    }
}

/**
 * Encrypt sensitive fields in a config object.
 * Returns a new object — does NOT mutate.
 */
export function encryptConfig<T extends Record<string, any>>(config: T): T {
    const result = { ...config };
    for (const field of SENSITIVE_FIELDS) {
        if (typeof result[field] === "string" && result[field] && !result[field].startsWith("enc:")) {
            result[field] = encryptValue(result[field]);
        }
    }
    return result;
}

/**
 * Decrypt sensitive fields in a config object.
 * Returns a new object — does NOT mutate.
 */
export function decryptConfig<T extends Record<string, any>>(config: T): T {
    const result = { ...config };
    for (const field of SENSITIVE_FIELDS) {
        if (typeof result[field] === "string" && result[field]) {
            result[field] = decryptValue(result[field]);
        }
    }
    return result;
}
