import { hmacSha256Base64, timingSafeEqualString } from "./crypto";
import {
	getDecryptionSecrets,
	getEncryptionSecret,
	getSettingsWithDiagnostics,
	setSettings,
} from "./db";
import type { AppBindings, ShopifyAddress } from "../types";

export const APP_SETTING_ID = "app";
export const APP_SECRET_KEYS = new Set(["client_secret", "access_token"]);

const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // Refresh 10 minutes before expiry

export interface AppSettingsData {
	shop_domain: string;
	client_id: string;
	client_secret: string;
	access_token: string;
	access_token_expires_at: string;
	decryptionErrors: string[];
}

export function normalizeShopDomain(input: string): string {
	const cleaned = input
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/.*$/, "")
		.toLowerCase();
	return cleaned;
}

export function normalizeLocationGid(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		return "";
	}
	if (trimmed.startsWith("gid://shopify/Location/")) {
		return trimmed;
	}
	if (/^\d+$/.test(trimmed)) {
		return `gid://shopify/Location/${trimmed}`;
	}
	return trimmed;
}

export function normalizeOrderGid(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		return "";
	}
	if (trimmed.startsWith("gid://shopify/Order/")) {
		return trimmed;
	}
	if (/^\d+$/.test(trimmed)) {
		return `gid://shopify/Order/${trimmed}`;
	}
	return trimmed;
}

export function formatShopifyAddress(addr?: ShopifyAddress | null): string {
	if (!addr) {
		return "";
	}
	if (Array.isArray(addr.formatted) && addr.formatted.length > 0) {
		return addr.formatted.map((s) => s.trim()).filter(Boolean).join(", ");
	}
	const parts = [
		addr.address1,
		addr.address2,
		addr.city,
		addr.province || addr.provinceCode || addr.province_code,
		addr.zip,
		addr.country || addr.countryCode || addr.countryCodeV2 || addr.country_code,
	]
		.map((part) => (typeof part === "string" ? part.trim() : ""))
		.filter(Boolean);
	return parts.join(", ");
}

export async function getAppSettings(env: AppBindings): Promise<AppSettingsData> {
	const { values: data, failedKeys } = await getSettingsWithDiagnostics(
		env.DB,
		APP_SETTING_ID,
		getDecryptionSecrets(env)
	);
	return {
		shop_domain: data.shop_domain || "",
		client_id: data.client_id || "",
		client_secret: data.client_secret || "",
		access_token: data.access_token || "",
		access_token_expires_at: data.access_token_expires_at || "",
		decryptionErrors: failedKeys,
	};
}

export async function verifyShopifyWebhookHmac(
	rawBody: string,
	hmacHeader: string | undefined,
	clientSecret: string
): Promise<boolean> {
	if (!hmacHeader || !clientSecret) {
		return false;
	}
	const computed = await hmacSha256Base64(rawBody, clientSecret);
	return timingSafeEqualString(computed, hmacHeader.trim());
}

interface AccessTokenResponse {
	access_token?: string;
	scope?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

export async function getShopifyAccessToken(
	env: AppBindings,
	forceRefresh = false
): Promise<{ shopDomain: string; accessToken: string; expiresAt: number }> {
	const settings = await getAppSettings(env);
	const shopDomain = normalizeShopDomain(settings.shop_domain);
	if (!shopDomain || !settings.client_id || !settings.client_secret) {
		throw new Error(
			"Shopify App credentials are incomplete. Please configure Store Domain, Client ID, and Client Secret in App Settings."
		);
	}

	const expiresAt = Number(settings.access_token_expires_at || "0");
	if (
		!forceRefresh &&
		settings.access_token &&
		Number.isFinite(expiresAt) &&
		Date.now() < expiresAt - TOKEN_REFRESH_BUFFER_MS
	) {
		return {
			shopDomain,
			accessToken: settings.access_token,
			expiresAt,
		};
	}

	const tokenUrl = `https://${shopDomain}/admin/oauth/access_token`;
	const res = await fetch(tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: settings.client_id,
			client_secret: settings.client_secret,
		}).toString(),
	});

	const rawText = await res.text();
	let data: AccessTokenResponse;
	try {
		data = JSON.parse(rawText) as AccessTokenResponse;
	} catch {
		throw new Error(`Shopify token endpoint returned non-JSON (${res.status}): ${rawText.slice(0, 200)}`);
	}

	if (!res.ok || !data.access_token) {
		const reason = data.error_description || data.error || rawText.slice(0, 200);
		throw new Error(`Failed to obtain Shopify access token (${res.status}): ${reason}`);
	}

	const ttlSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 86399;
	const nextExpiresAt = Date.now() + ttlSeconds * 1000;

	await setSettings(
		env.DB,
		APP_SETTING_ID,
		{
			access_token: data.access_token,
			access_token_expires_at: String(nextExpiresAt),
		},
		APP_SECRET_KEYS,
		getEncryptionSecret(env)
	);

	return {
		shopDomain,
		accessToken: data.access_token,
		expiresAt: nextExpiresAt,
	};
}

interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message: string }>;
}

export async function shopifyGraphQL<T>(
	env: AppBindings,
	query: string,
	variables?: Record<string, unknown>,
	retryOn401 = true
): Promise<T> {
	const apiVersion = env.SHOPIFY_API_VERSION || "2026-04";
	const { shopDomain, accessToken } = await getShopifyAccessToken(env, false);

	const execute = async (token: string) =>
		fetch(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Shopify-Access-Token": token,
			},
			body: JSON.stringify({ query, variables }),
		});

	let res = await execute(accessToken);
	if (res.status === 401 && retryOn401) {
		const refreshed = await getShopifyAccessToken(env, true);
		res = await execute(refreshed.accessToken);
	}

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Shopify GraphQL HTTP ${res.status}: ${errText.slice(0, 300)}`);
	}

	const payload = (await res.json()) as GraphQLResponse<T>;
	if (payload.errors && payload.errors.length > 0) {
		throw new Error(`Shopify GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`);
	}
	if (!payload.data) {
		throw new Error("Shopify GraphQL returned empty data");
	}
	return payload.data;
}

export async function testShopifyConnection(env: AppBindings): Promise<{
	shopName: string;
	myshopifyDomain: string;
	expiresAt: number;
}> {
	const tokenInfo = await getShopifyAccessToken(env, true);
	const data = await shopifyGraphQL<{
		shop: { name: string; myshopifyDomain: string };
	}>(
		env,
		`query TestShopConnection {
			shop {
				name
				myshopifyDomain
			}
		}`
	);
	return {
		shopName: data.shop.name,
		myshopifyDomain: data.shop.myshopifyDomain,
		expiresAt: tokenInfo.expiresAt,
	};
}

export async function fetchShopifyLocationAddress(
	env: AppBindings,
	locationIdInput: string
): Promise<{ id: string; name: string; formattedAddress: string }> {
	const locationGid = normalizeLocationGid(locationIdInput);
	const data = await shopifyGraphQL<{
		location: {
			id: string;
			name: string;
			address: ShopifyAddress;
		} | null;
	}>(
		env,
		`query GetLocationAddress($id: ID!) {
			location(id: $id) {
				id
				name
				address {
					address1
					address2
					city
					province
					provinceCode
					zip
					country
					countryCode
					formatted
				}
			}
		}`,
		{ id: locationGid }
	);

	if (!data.location) {
		throw new Error(`Shopify Location not found for ID: ${locationIdInput}`);
	}

	const formattedAddress = formatShopifyAddress(data.location.address);
	if (!formattedAddress) {
		throw new Error(`Shopify Location "${data.location.name}" has an empty address`);
	}

	return {
		id: data.location.id,
		name: data.location.name,
		formattedAddress,
	};
}

export async function resolveMetafieldTarget(
	env: AppBindings,
	input: string
): Promise<{ namespace: string; key: string; normalizedTarget: string }> {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Metafield target is required (e.g. custom.delivery_distance)");
	}

	// If user entered a Metafield Definition GID or numeric ID, look up its namespace & key via Shopify GraphQL
	if (trimmed.startsWith("gid://shopify/MetafieldDefinition/") || /^\d+$/.test(trimmed)) {
		const defGid = trimmed.startsWith("gid://")
			? trimmed
			: `gid://shopify/MetafieldDefinition/${trimmed}`;

		const data = await shopifyGraphQL<{
			metafieldDefinition: {
				id: string;
				namespace: string;
				key: string;
				ownerType: string;
			} | null;
		}>(
			env,
			`query ResolveMetafieldDefinition($id: ID!) {
				metafieldDefinition(id: $id) {
					id
					namespace
					key
					ownerType
				}
			}`,
			{ id: defGid }
		);

		if (!data.metafieldDefinition) {
			throw new Error(`Metafield definition not found for ID: ${trimmed}`);
		}
		if (data.metafieldDefinition.ownerType !== "ORDER") {
			throw new Error(
				`Metafield definition ${trimmed} belongs to ${data.metafieldDefinition.ownerType}, expected ORDER`
			);
		}
		return {
			namespace: data.metafieldDefinition.namespace,
			key: data.metafieldDefinition.key,
			normalizedTarget: `${data.metafieldDefinition.namespace}.${data.metafieldDefinition.key}`,
		};
	}

	const dotIndex = trimmed.indexOf(".");
	if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
		throw new Error(
			`Invalid metafield format "${trimmed}". Use "namespace.key" (e.g. custom.delivery_distance) or a Metafield Definition ID.`
		);
	}

	const namespace = trimmed.slice(0, dotIndex).trim();
	const key = trimmed.slice(dotIndex + 1).trim();
	return {
		namespace,
		key,
		normalizedTarget: `${namespace}.${key}`,
	};
}

export async function setOrderSingleLineTextMetafield(
	env: AppBindings,
	orderGid: string,
	namespace: string,
	key: string,
	value: string
): Promise<void> {
	const data = await shopifyGraphQL<{
		metafieldsSet: {
			metafields: Array<{ id: string; namespace: string; key: string; value: string }>;
			userErrors: Array<{ field?: string[]; message: string; code?: string }>;
		};
	}>(
		env,
		`mutation SetOrderDistanceMetafield($metafields: [MetafieldsSetInput!]!) {
			metafieldsSet(metafields: $metafields) {
				metafields {
					id
					namespace
					key
					value
				}
				userErrors {
					field
					message
					code
				}
			}
		}`,
		{
			metafields: [
				{
					ownerId: normalizeOrderGid(orderGid),
					namespace,
					key,
					type: "single_line_text_field",
					value,
				},
			],
		}
	);

	const errors = data.metafieldsSet.userErrors;
	if (errors && errors.length > 0) {
		throw new Error(`Shopify metafieldsSet failed: ${errors.map((e) => e.message).join("; ")}`);
	}
}

export async function fetchShopifyOrderForDistance(
	env: AppBindings,
	orderIdInput: string
): Promise<{
	id: string;
	name: string;
	financialStatus: string;
	shippingAddress: ShopifyAddress | null;
}> {
	const orderGid = normalizeOrderGid(orderIdInput);
	const data = await shopifyGraphQL<{
		order: {
			id: string;
			name: string;
			displayFinancialStatus: string | null;
			shippingAddress: ShopifyAddress | null;
		} | null;
	}>(
		env,
		`query GetOrderForDistance($id: ID!) {
			order(id: $id) {
				id
				name
				displayFinancialStatus
				shippingAddress {
					address1
					address2
					city
					province
					provinceCode
					zip
					country
					countryCodeV2
					formatted
				}
			}
		}`,
		{ id: orderGid }
	);

	if (!data.order) {
		throw new Error(`Order not found: ${orderIdInput}`);
	}

	return {
		id: data.order.id,
		name: data.order.name,
		financialStatus: (data.order.displayFinancialStatus || "").toLowerCase(),
		shippingAddress: data.order.shippingAddress,
	};
}

export interface WebhookSubscriptionInfo {
	id: string;
	topic: string;
	uri: string;
}

export async function listShopifyWebhookSubscriptions(
	env: AppBindings
): Promise<WebhookSubscriptionInfo[]> {
	const data = await shopifyGraphQL<{
		webhookSubscriptions: {
			edges: Array<{
				node: {
					id: string;
					topic: string;
					uri?: string | null;
				};
			}>;
		};
	}>(
		env,
		`query ListWebhookSubscriptions {
			webhookSubscriptions(first: 50) {
				edges {
					node {
						id
						topic
						uri
					}
				}
			}
		}`
	);

	return data.webhookSubscriptions.edges.map(({ node }) => ({
		id: node.id,
		topic: node.topic,
		uri: node.uri || "",
	}));
}

export async function syncShopifyOrderWebhooks(
	env: AppBindings,
	targetUri: string
): Promise<{ created: string[]; existing: string[] }> {
	const requiredTopics = ["ORDERS_PAID", "ORDERS_UPDATED"] as const;
	const existingSubs = await listShopifyWebhookSubscriptions(env);

	const created: string[] = [];
	const existing: string[] = [];

	for (const topic of requiredTopics) {
		const match = existingSubs.find((s) => s.topic === topic && s.uri === targetUri);
		if (match) {
			existing.push(topic);
			continue;
		}

		// Delete outdated subscriptions for the same topic owned by this app if URI differs
		for (const stale of existingSubs.filter((s) => s.topic === topic && s.uri !== targetUri)) {
			await shopifyGraphQL(
				env,
				`mutation DeleteStaleWebhook($id: ID!) {
					webhookSubscriptionDelete(id: $id) {
						deletedWebhookSubscriptionId
						userErrors { message }
					}
				}`,
				{ id: stale.id }
			);
		}

		const createRes = await shopifyGraphQL<{
			webhookSubscriptionCreate: {
				webhookSubscription: { id: string; topic: string; uri: string } | null;
				userErrors: Array<{ field?: string[]; message: string }>;
			};
		}>(
			env,
			`mutation CreateOrderWebhook($topic: WebhookSubscriptionTopic!, $uri: String!) {
				webhookSubscriptionCreate(
					topic: $topic
					webhookSubscription: { uri: $uri, format: JSON }
				) {
					webhookSubscription {
						id
						topic
						uri
					}
					userErrors {
						field
						message
					}
				}
			}`,
			{ topic, uri: targetUri }
		);

		const errs = createRes.webhookSubscriptionCreate.userErrors;
		if (errs && errs.length > 0) {
			throw new Error(`Failed to register ${topic}: ${errs.map((e) => e.message).join("; ")}`);
		}
		created.push(topic);
	}

	return { created, existing };
}
