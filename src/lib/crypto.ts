const ENC_PREFIX = "enc:v1:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(input: string): Uint8Array {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
	return base64ToBytes(normalized + pad);
}

export function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", encoder.encode(input));
	return bytesToHex(new Uint8Array(hash));
}

export async function hmacSha256Bytes(data: string | Uint8Array, secret: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const payload = typeof data === "string" ? encoder.encode(data) : data;
	const signature = await crypto.subtle.sign("HMAC", key, payload);
	return new Uint8Array(signature);
}

export async function hmacSha256Base64(data: string | Uint8Array, secret: string): Promise<string> {
	return bytesToBase64(await hmacSha256Bytes(data, secret));
}

export async function hmacSha256Base64Url(data: string | Uint8Array, secret: string): Promise<string> {
	return bytesToBase64Url(await hmacSha256Bytes(data, secret));
}

export function timingSafeEqualString(a: string, b: string): boolean {
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.length !== bBytes.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

async function deriveAesKey(secret: string, usages: ("encrypt" | "decrypt")[]): Promise<CryptoKey> {
	const hash = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
	return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, usages);
}

export async function encryptValue(plaintext: string, secret?: string): Promise<string> {
	if (!plaintext || !secret) {
		return plaintext;
	}
	const key = await deriveAesKey(secret, ["encrypt"]);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext))
	);
	const combined = new Uint8Array(iv.length + encrypted.length);
	combined.set(iv, 0);
	combined.set(encrypted, iv.length);
	return `${ENC_PREFIX}${bytesToBase64(combined)}`;
}

export async function decryptValue(stored: string, secret?: string): Promise<string> {
	if (!stored || !stored.startsWith(ENC_PREFIX)) {
		return stored;
	}
	if (!secret) {
		throw new Error("Missing ENCRYPTION_KEY / SESSION_SECRET to decrypt stored secret");
	}
	const combined = base64ToBytes(stored.slice(ENC_PREFIX.length));
	if (combined.length < 13) {
		throw new Error("Invalid encrypted payload");
	}
	const iv = combined.slice(0, 12);
	const ciphertext = combined.slice(12);
	const key = await deriveAesKey(secret, ["decrypt"]);
	const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
	return decoder.decode(decrypted);
}

export function maskSecret(value?: string): string {
	if (!value) {
		return "";
	}
	if (value.length <= 4) {
		return "••••";
	}
	return `••••••••${value.slice(-4)}`;
}

export function randomToken(byteLength = 24): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return bytesToBase64Url(bytes);
}

/**
 * Returns a safe, non-reversible 8-char hex fingerprint of the active encryption key
 * so local (.dev.vars) and production (Cloudflare Secrets) can be compared without leaking secrets.
 */
export async function getKeyFingerprint(secret?: string): Promise<string> {
	if (!secret) {
		return "none";
	}
	const hex = await sha256Hex(`cht-shopify-apps:key-fp:v1:${secret}`);
	return hex.slice(0, 8);
}
