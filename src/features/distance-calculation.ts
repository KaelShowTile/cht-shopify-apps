import { sha256Hex } from "../lib/crypto";
import {
	getEncryptionSecret,
	getLatestSuccessfulAddressHash,
	getSettings,
	hasProcessedWebhook,
	insertWebhookLog,
	setSettings,
} from "../lib/db";
import { computeDrivingDistanceMeters } from "../lib/google-maps";
import {
	fetchShopifyLocationAddress,
	fetchShopifyOrderForDistance,
	formatShopifyAddress,
	normalizeLocationGid,
	normalizeOrderGid,
	setOrderSingleLineTextMetafield,
} from "../lib/shopify";
import type { AppBindings, ShopifyOrderWebhookPayload } from "../types";

export const DISTANCE_SETTING_ID = "distance_calculation";
export const DISTANCE_SECRET_KEYS = new Set(["google_maps_api_key"]);

export interface DistanceSettingsData {
	enabled: boolean;
	google_maps_api_key: string;
	location_id: string;
	metafield_namespace: string;
	metafield_key: string;
	metafield_raw: string;
	warehouse_address_cache: string;
	warehouse_location_name: string;
	warehouse_cached_location_id: string;
}

export async function getDistanceSettings(env: AppBindings): Promise<DistanceSettingsData> {
	const data = await getSettings(env.DB, DISTANCE_SETTING_ID, getEncryptionSecret(env));
	return {
		enabled: data.enabled !== "false",
		google_maps_api_key: data.google_maps_api_key || "",
		location_id: data.location_id || "",
		metafield_namespace: data.metafield_namespace || "",
		metafield_key: data.metafield_key || "",
		metafield_raw:
			data.metafield_raw ||
			(data.metafield_namespace && data.metafield_key
				? `${data.metafield_namespace}.${data.metafield_key}`
				: ""),
		warehouse_address_cache: data.warehouse_address_cache || "",
		warehouse_location_name: data.warehouse_location_name || "",
		warehouse_cached_location_id: data.warehouse_cached_location_id || "",
	};
}

export function isOrderPaidStatus(financialStatus?: string | null): boolean {
	if (!financialStatus) {
		return false;
	}
	const normalized = financialStatus.trim().toLowerCase();
	return normalized === "paid" || normalized === "partially_refunded";
}

export interface ProcessDistanceResult {
	status: "success" | "skipped" | "error";
	distanceMeters?: number;
	message: string;
}

async function getOrFetchWarehouseAddress(
	env: AppBindings,
	settings: DistanceSettingsData
): Promise<string> {
	const locationGid = normalizeLocationGid(settings.location_id);
	if (
		settings.warehouse_address_cache &&
		settings.warehouse_cached_location_id === locationGid
	) {
		return settings.warehouse_address_cache;
	}

	const resolved = await fetchShopifyLocationAddress(env, locationGid);
	await setSettings(
		env.DB,
		DISTANCE_SETTING_ID,
		{
			warehouse_address_cache: resolved.formattedAddress,
			warehouse_location_name: resolved.name,
			warehouse_cached_location_id: resolved.id,
		},
		DISTANCE_SECRET_KEYS,
		getEncryptionSecret(env)
	);
	return resolved.formattedAddress;
}

export async function processOrderDistanceEvent(
	env: AppBindings,
	params: {
		topic: "orders/paid" | "orders/updated" | "manual_test";
		webhookId?: string | null;
		order: ShopifyOrderWebhookPayload;
		forceRecalculate?: boolean;
	}
): Promise<ProcessDistanceResult> {
	const { topic, webhookId, order, forceRecalculate = false } = params;
	const orderGid = order.admin_graphql_api_id
		? order.admin_graphql_api_id
		: normalizeOrderGid(String(order.id));
	const orderName = order.name || orderGid;

	// 1. Exact webhook deduplication
	if (webhookId && (await hasProcessedWebhook(env.DB, webhookId))) {
		return { status: "skipped", message: "Duplicate webhook ignored" };
	}

	// 2. Load feature settings
	const settings = await getDistanceSettings(env);
	if (!settings.enabled && !forceRecalculate) {
		return { status: "skipped", message: "Distance Calculation feature is disabled" };
	}

	// 3. For orders/updated, only process already-paid orders (skip unpaid orders silently)
	if (topic === "orders/updated" && !isOrderPaidStatus(order.financial_status)) {
		return { status: "skipped", message: "Order is not paid yet; skipped orders/updated" };
	}

	// 4. Validate required configuration
	if (
		!settings.google_maps_api_key ||
		!settings.location_id ||
		!settings.metafield_namespace ||
		!settings.metafield_key
	) {
		const msg =
			"Distance Calculation settings are incomplete (Google Maps API Key, Location ID, or Metafield missing)";
		await insertWebhookLog(env.DB, {
			feature: DISTANCE_SETTING_ID,
			webhookId,
			topic,
			orderId: orderGid,
			orderName,
			status: "error",
			message: msg,
		});
		return { status: "error", message: msg };
	}

	// 5. Extract destination shipping address
	const destinationAddress = formatShopifyAddress(order.shipping_address);
	if (!destinationAddress) {
		const msg = "Order has no shipping address (digital or local pickup); skipped";
		await insertWebhookLog(env.DB, {
			feature: DISTANCE_SETTING_ID,
			webhookId,
			topic,
			orderId: orderGid,
			orderName,
			status: "skipped",
			message: msg,
		});
		return { status: "skipped", message: msg };
	}

	// 6. Compare address hash to prevent infinite loops on orders/updated & avoid duplicate API charges
	const normalizedLocation = normalizeLocationGid(settings.location_id);
	const addressHash = await sha256Hex(
		`${normalizedLocation}|${destinationAddress.toLowerCase()}`
	);

	if (!forceRecalculate) {
		const previousHash = await getLatestSuccessfulAddressHash(
			env.DB,
			DISTANCE_SETTING_ID,
			orderGid
		);
		if (previousHash && previousHash === addressHash) {
			return {
				status: "skipped",
				message: "Shipping address unchanged since last successful calculation",
			};
		}
	}

	// 7. Compute distance & write integer meters to order metafield
	try {
		const warehouseAddress = await getOrFetchWarehouseAddress(env, settings);
		const distanceMeters = await computeDrivingDistanceMeters(
			settings.google_maps_api_key,
			warehouseAddress,
			destinationAddress
		);

		await setOrderSingleLineTextMetafield(
			env,
			orderGid,
			settings.metafield_namespace,
			settings.metafield_key,
			String(distanceMeters)
		);

		const msg = `Saved ${distanceMeters} m to ${settings.metafield_namespace}.${settings.metafield_key}`;
		await insertWebhookLog(env.DB, {
			feature: DISTANCE_SETTING_ID,
			webhookId,
			topic,
			orderId: orderGid,
			orderName,
			addressHash,
			destinationAddress,
			distanceMeters,
			status: "success",
			message: msg,
		});

		return {
			status: "success",
			distanceMeters,
			message: msg,
		};
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		await insertWebhookLog(env.DB, {
			feature: DISTANCE_SETTING_ID,
			webhookId,
			topic,
			orderId: orderGid,
			orderName,
			addressHash,
			destinationAddress,
			status: "error",
			message: errMsg,
		});
		return { status: "error", message: errMsg };
	}
}

export async function runManualOrderDistanceCalculation(
	env: AppBindings,
	orderIdInput: string
): Promise<ProcessDistanceResult> {
	const order = await fetchShopifyOrderForDistance(env, orderIdInput);
	return processOrderDistanceEvent(env, {
		topic: "manual_test",
		order: {
			id: order.id,
			admin_graphql_api_id: order.id,
			name: order.name,
			financial_status: order.financialStatus,
			shipping_address: order.shippingAddress,
		},
		forceRecalculate: true,
	});
}
