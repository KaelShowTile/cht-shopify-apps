import { decryptValue, encryptValue } from "./crypto";
import type { AppBindings, WebhookLogRow } from "../types";

const initializedDbs = new WeakSet<D1Database>();

export function getEncryptionSecret(env: AppBindings): string | undefined {
	const raw = env.ENCRYPTION_KEY || env.SESSION_SECRET;
	return raw ? raw.trim() : undefined;
}

export function getDecryptionSecrets(env: AppBindings): string[] {
	const candidates = [
		env.ENCRYPTION_KEY?.trim(),
		env.ENCRYPTION_KEY,
		env.SESSION_SECRET?.trim(),
		env.SESSION_SECRET,
	];
	const unique: string[] = [];
	for (const candidate of candidates) {
		if (candidate && !unique.includes(candidate)) {
			unique.push(candidate);
		}
	}
	return unique;
}

export async function ensureSchema(db: D1Database): Promise<void> {
	if (initializedDbs.has(db)) {
		return;
	}
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS settings (
				setting_id TEXT NOT NULL,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (setting_id, key)
			)`
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS webhook_logs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				feature TEXT NOT NULL,
				webhook_id TEXT,
				topic TEXT NOT NULL,
				order_id TEXT NOT NULL,
				order_name TEXT,
				address_hash TEXT,
				destination_address TEXT,
				distance_meters INTEGER,
				status TEXT NOT NULL,
				message TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)`
		),
		db.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_logs_webhook_id
			 ON webhook_logs(webhook_id)
			 WHERE webhook_id IS NOT NULL`
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_webhook_logs_feature_order
			 ON webhook_logs(feature, order_id, id DESC)`
		),
	]);
	initializedDbs.add(db);
}

export interface SettingsReadResult {
	values: Record<string, string>;
	failedKeys: string[];
}

export async function getSettingsWithDiagnostics(
	db: D1Database,
	settingId: string,
	secrets?: string | string[]
): Promise<SettingsReadResult> {
	await ensureSchema(db);
	const { results } = await db
		.prepare("SELECT key, value FROM settings WHERE setting_id = ?")
		.bind(settingId)
		.all<{ key: string; value: string }>();

	const secretList = Array.isArray(secrets)
		? secrets.filter(Boolean)
		: secrets
			? [secrets]
			: [];

	const values: Record<string, string> = {};
	const failedKeys: string[] = [];

	for (const row of results) {
		if (!row.value.startsWith("enc:v1:")) {
			values[row.key] = row.value;
			continue;
		}

		let decrypted: string | null = null;
		let lastError: unknown = null;

		for (const candidate of secretList) {
			try {
				decrypted = await decryptValue(row.value, candidate);
				break;
			} catch (err) {
				lastError = err;
			}
		}

		if (decrypted !== null) {
			values[row.key] = decrypted;
		} else {
			console.error(
				`[D1 settings] Failed to decrypt ${settingId}.${row.key}:`,
				lastError instanceof Error ? lastError.message : String(lastError)
			);
			values[row.key] = "";
			failedKeys.push(row.key);
		}
	}

	return { values, failedKeys };
}

export async function getSettings(
	db: D1Database,
	settingId: string,
	encryptionSecret?: string | string[]
): Promise<Record<string, string>> {
	const { values } = await getSettingsWithDiagnostics(db, settingId, encryptionSecret);
	return values;
}

export async function setSettings(
	db: D1Database,
	settingId: string,
	entries: Record<string, string>,
	secretKeys: ReadonlySet<string> = new Set(),
	encryptionSecret?: string
): Promise<void> {
	await ensureSchema(db);
	const statements: D1PreparedStatement[] = [];

	for (const [key, rawValue] of Object.entries(entries)) {
		const value =
			secretKeys.has(key) && rawValue
				? await encryptValue(rawValue, encryptionSecret)
				: rawValue;

		statements.push(
			db
				.prepare(
					`INSERT INTO settings (setting_id, key, value)
					 VALUES (?, ?, ?)
					 ON CONFLICT(setting_id, key)
					 DO UPDATE SET value = excluded.value`
				)
				.bind(settingId, key, value)
		);
	}

	if (statements.length > 0) {
		await db.batch(statements);
	}
}

export async function deleteSetting(
	db: D1Database,
	settingId: string,
	key: string
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare("DELETE FROM settings WHERE setting_id = ? AND key = ?")
		.bind(settingId, key)
		.run();
}

export async function hasProcessedWebhook(
	db: D1Database,
	webhookId: string
): Promise<boolean> {
	await ensureSchema(db);
	const row = await db
		.prepare("SELECT id FROM webhook_logs WHERE webhook_id = ? LIMIT 1")
		.bind(webhookId)
		.first<{ id: number }>();
	return Boolean(row);
}

export async function getLatestSuccessfulAddressHash(
	db: D1Database,
	feature: string,
	orderId: string
): Promise<string | null> {
	await ensureSchema(db);
	const row = await db
		.prepare(
			`SELECT address_hash FROM webhook_logs
			 WHERE feature = ? AND order_id = ? AND status = 'success'
			 ORDER BY id DESC
			 LIMIT 1`
		)
		.bind(feature, orderId)
		.first<{ address_hash: string | null }>();
	return row?.address_hash ?? null;
}

export interface NewWebhookLog {
	feature: string;
	webhookId?: string | null;
	topic: string;
	orderId: string;
	orderName?: string | null;
	addressHash?: string | null;
	destinationAddress?: string | null;
	distanceMeters?: number | null;
	status: "success" | "skipped" | "error";
	message?: string | null;
}

export async function insertWebhookLog(
	db: D1Database,
	log: NewWebhookLog
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT OR IGNORE INTO webhook_logs (
				feature, webhook_id, topic, order_id, order_name,
				address_hash, destination_address, distance_meters, status, message
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			log.feature,
			log.webhookId ?? null,
			log.topic,
			log.orderId,
			log.orderName ?? null,
			log.addressHash ?? null,
			log.destinationAddress ?? null,
			log.distanceMeters ?? null,
			log.status,
			log.message ?? null
		)
		.run();
}

export async function getRecentWebhookLogs(
	db: D1Database,
	feature: string,
	limit = 20
): Promise<WebhookLogRow[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(
			`SELECT id, feature, webhook_id, topic, order_id, order_name,
			        address_hash, destination_address, distance_meters, status, message, created_at
			 FROM webhook_logs
			 WHERE feature = ?
			 ORDER BY id DESC
			 LIMIT ?`
		)
		.bind(feature, limit)
		.all<WebhookLogRow>();
	return results;
}
