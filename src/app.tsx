import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
	clearSession,
	consumeOAuthState,
	createSession,
	exchangeGoogleCodeForUser,
	getAppBaseUrl,
	initiateGoogleOAuth,
	isEmailAllowed,
	isOAuthConfigured,
	requireAuth,
	sanitizeNextPath,
	verifySessionToken,
} from "./lib/auth";
import { getKeyFingerprint } from "./lib/crypto";
import {
	deleteSetting,
	getEncryptionSecret,
	getRecentWebhookLogs,
	setSettings,
} from "./lib/db";
import {
	APP_SECRET_KEYS,
	APP_SETTING_ID,
	fetchShopifyLocationAddress,
	getAppSettings,
	listShopifyWebhookSubscriptions,
	normalizeLocationGid,
	normalizeShopDomain,
	resolveMetafieldTarget,
	syncShopifyOrderWebhooks,
	testShopifyConnection,
	verifyShopifyWebhookHmac,
	type WebhookSubscriptionInfo,
} from "./lib/shopify";
import {
	DISTANCE_SECRET_KEYS,
	DISTANCE_SETTING_ID,
	getDistanceSettings,
	processOrderDistanceEvent,
	runManualOrderDistanceCalculation,
} from "./features/distance-calculation";
import { FEATURES } from "./features/registry";
import { LoginPage } from "./views/LoginPage";
import { DashboardPage, type FeatureStatusSummary } from "./views/DashboardPage";
import { AppSettingsPage } from "./views/AppSettingsPage";
import { DistanceSettingsPage } from "./views/DistanceSettingsPage";
import type { HonoAppEnv, ShopifyOrderWebhookPayload } from "./types";

function redirectWithFlash(
	path: string,
	type: "success" | "error",
	message: string
): string {
	const params = new URLSearchParams({ [type]: message });
	return `${path}?${params.toString()}`;
}

export const app = new Hono<HonoAppEnv>();

// ---------- Public Health Endpoint ----------
app.get("/health", (c) => c.json({ ok: true }));

// ---------- Auth Routes ----------
app.get("/login", async (c) => {
	const token = getCookie(c, "cht_session");
	const existing = await verifySessionToken(token, c.env.SESSION_SECRET);
	if (existing && isEmailAllowed(existing.email, c.env.ALLOWED_EMAILS)) {
		return c.redirect("/");
	}

	const callbackUrl = `${getAppBaseUrl(c.req.raw, c.env)}/auth/callback`;
	const nextPath = sanitizeNextPath(c.req.query("next"));
	const errorMessage = c.req.query("error");

	return c.html(
		<LoginPage
			oauthConfigured={isOAuthConfigured(c.env)}
			callbackUrl={callbackUrl}
			nextPath={nextPath}
			errorMessage={errorMessage}
		/>
	);
});

app.get("/auth/google", (c) => {
	if (!isOAuthConfigured(c.env)) {
		return c.redirect("/login?error=Google+OAuth+is+not+configured");
	}
	const authUrl = initiateGoogleOAuth(c);
	return c.redirect(authUrl);
});

app.get("/auth/callback", async (c) => {
	if (!isOAuthConfigured(c.env)) {
		return c.redirect("/login?error=Google+OAuth+is+not+configured");
	}

	const oauthError = c.req.query("error");
	if (oauthError) {
		return c.redirect(
			redirectWithFlash("/login", "error", `Google sign-in cancelled: ${oauthError}`)
		);
	}

	const code = c.req.query("code");
	const state = c.req.query("state");
	const { valid, next } = consumeOAuthState(c, state);

	if (!valid || !code) {
		return c.redirect(
			redirectWithFlash("/login", "error", "Invalid or expired OAuth state. Please try again.")
		);
	}

	try {
		const redirectUri = `${getAppBaseUrl(c.req.raw, c.env)}/auth/callback`;
		const userInfo = await exchangeGoogleCodeForUser(
			code,
			redirectUri,
			c.env.GOOGLE_CLIENT_ID!,
			c.env.GOOGLE_CLIENT_SECRET!
		);

		if (userInfo.email_verified === false) {
			return c.redirect(
				redirectWithFlash("/login", "error", "Your Google email address is not verified.")
			);
		}

		if (!isEmailAllowed(userInfo.email, c.env.ALLOWED_EMAILS)) {
			return c.redirect(
				redirectWithFlash(
					"/login",
					"error",
					`Access denied: ${userInfo.email} is not in the authorized email whitelist.`
				)
			);
		}

		await createSession(c, {
			email: userInfo.email,
			name: userInfo.name || userInfo.email,
			picture: userInfo.picture,
		});

		return c.redirect(next);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return c.redirect(redirectWithFlash("/login", "error", `Authentication failed: ${msg}`));
	}
});

app.post("/auth/logout", (c) => {
	clearSession(c);
	return c.redirect("/login");
});

// ---------- Shopify Webhook Endpoint (HMAC-Protected, No Cookie Auth) ----------
app.post("/webhooks/shopify/orders", async (c) => {
	const rawBody = await c.req.text();
	const hmacHeader = c.req.header("x-shopify-hmac-sha256");
	const topicHeader = (c.req.header("x-shopify-topic") || "").toLowerCase();
	const webhookId = c.req.header("x-shopify-webhook-id") || null;

	const appSettings = await getAppSettings(c.env);
	if (!appSettings.client_secret) {
		return c.text("Shopify Client Secret is not configured", 500);
	}

	const isValid = await verifyShopifyWebhookHmac(
		rawBody,
		hmacHeader,
		appSettings.client_secret
	);
	if (!isValid) {
		return c.text("Invalid Shopify webhook HMAC signature", 401);
	}

	if (topicHeader !== "orders/paid" && topicHeader !== "orders/updated") {
		return c.json({ ok: true, ignored: true, topic: topicHeader });
	}

	let orderPayload: ShopifyOrderWebhookPayload;
	try {
		orderPayload = JSON.parse(rawBody) as ShopifyOrderWebhookPayload;
	} catch {
		return c.text("Invalid JSON payload", 400);
	}

	if (!orderPayload.id && !orderPayload.admin_graphql_api_id) {
		return c.text("Missing order id in webhook payload", 400);
	}

	const task = processOrderDistanceEvent(c.env, {
		topic: topicHeader,
		webhookId,
		order: orderPayload,
	});

	// Respond immediately (<5s Shopify webhook SLA) and finish work asynchronously
	try {
		c.executionCtx.waitUntil(task);
	} catch {
		await task;
	}

	return c.json({ ok: true, queued: true });
});

// ---------- Protected Admin Dashboard & Feature Routes ----------
app.use("/", requireAuth);
app.use("/features/*", requireAuth);

app.get("/", async (c) => {
	const user = c.get("user");
	const [appSettings, distanceSettings] = await Promise.all([
		getAppSettings(c.env),
		getDistanceSettings(c.env),
	]);

	const appConfigured = Boolean(
		appSettings.shop_domain && appSettings.client_id && appSettings.client_secret
	);
	const distanceConfigured = Boolean(
		distanceSettings.google_maps_api_key &&
			distanceSettings.location_id &&
			distanceSettings.metafield_namespace &&
			distanceSettings.metafield_key
	);

	const statuses: Record<string, FeatureStatusSummary> = {
		app: appConfigured
			? { label: "Configured", tone: "success" }
			: { label: "Needs Setup", tone: "warn" },
		distance_calculation: !distanceSettings.enabled
			? { label: "Disabled", tone: "neutral" }
			: distanceConfigured
				? { label: "Active", tone: "success" }
				: { label: "Needs Setup", tone: "warn" },
	};

	return c.html(
		<DashboardPage
			user={user}
			features={FEATURES}
			statuses={statuses}
			shopDomain={appSettings.shop_domain}
		/>
	);
});

// ---------- Feature 1: App Settings ----------
app.get("/features/app-settings", async (c) => {
	const user = c.get("user");
	const [settings, keyFingerprint] = await Promise.all([
		getAppSettings(c.env),
		getKeyFingerprint(getEncryptionSecret(c.env)),
	]);
	return c.html(
		<AppSettingsPage
			user={user}
			settings={settings}
			keyFingerprint={keyFingerprint}
			flashSuccess={c.req.query("success")}
			flashError={c.req.query("error")}
		/>
	);
});

app.post("/features/app-settings", async (c) => {
	const body = await c.req.parseBody();
	const shopDomain = normalizeShopDomain(String(body.shop_domain || ""));
	const clientId = String(body.client_id || "").trim();
	const clientSecretInput = String(body.client_secret || "").trim();

	if (!shopDomain || !clientId) {
		return c.redirect(
			redirectWithFlash(
				"/features/app-settings",
				"error",
				"Shopify Store Domain and Client ID are required."
			)
		);
	}

	const existing = await getAppSettings(c.env);
	const nextClientSecret = clientSecretInput || existing.client_secret;
	if (!nextClientSecret) {
		return c.redirect(
			redirectWithFlash("/features/app-settings", "error", "Client Secret is required.")
		);
	}

	const credentialsChanged =
		existing.shop_domain !== shopDomain ||
		existing.client_id !== clientId ||
		Boolean(clientSecretInput);

	await setSettings(
		c.env.DB,
		APP_SETTING_ID,
		{
			shop_domain: shopDomain,
			client_id: clientId,
			client_secret: nextClientSecret,
		},
		APP_SECRET_KEYS,
		getEncryptionSecret(c.env)
	);

	if (credentialsChanged) {
		await Promise.all([
			deleteSetting(c.env.DB, APP_SETTING_ID, "access_token"),
			deleteSetting(c.env.DB, APP_SETTING_ID, "access_token_expires_at"),
		]);
	}

	return c.redirect(
		redirectWithFlash(
			"/features/app-settings",
			"success",
			"App settings saved. You can test the connection below."
		)
	);
});

app.post("/features/app-settings/test-token", async (c) => {
	try {
		const result = await testShopifyConnection(c.env);
		return c.redirect(
			redirectWithFlash(
				"/features/app-settings",
				"success",
				`Connected to "${result.shopName}" (${result.myshopifyDomain}). Token cached until ${new Date(result.expiresAt).toISOString()}.`
			)
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return c.redirect(redirectWithFlash("/features/app-settings", "error", msg));
	}
});

// ---------- Feature 2: Distance Calculation ----------
app.get("/features/distance-calculation", async (c) => {
	const user = c.get("user");
	const [appSettings, distanceSettings, logs, keyFingerprint] = await Promise.all([
		getAppSettings(c.env),
		getDistanceSettings(c.env),
		getRecentWebhookLogs(c.env.DB, DISTANCE_SETTING_ID, 20),
		getKeyFingerprint(getEncryptionSecret(c.env)),
	]);

	const webhookEndpointUrl = `${getAppBaseUrl(c.req.raw, c.env)}/webhooks/shopify/orders`;
	let webhooks: WebhookSubscriptionInfo[] = [];
	let webhookListError: string | undefined;

	if (appSettings.shop_domain && appSettings.client_id && appSettings.client_secret) {
		try {
			webhooks = await listShopifyWebhookSubscriptions(c.env);
		} catch (error) {
			webhookListError = `Could not query Shopify webhooks: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	} else {
		webhookListError = "Configure Shopify App Settings first to inspect or register webhooks.";
	}

	return c.html(
		<DistanceSettingsPage
			user={user}
			settings={distanceSettings}
			keyFingerprint={keyFingerprint}
			webhookEndpointUrl={webhookEndpointUrl}
			webhooks={webhooks}
			webhookListError={webhookListError}
			logs={logs}
			flashSuccess={c.req.query("success")}
			flashError={c.req.query("error")}
		/>
	);
});

app.post("/features/distance-calculation", async (c) => {
	const body = await c.req.parseBody();
	const enabled = body.enabled === "true" || body.enabled === "on";
	const apiKeyInput = String(body.google_maps_api_key || "").trim();
	const locationIdInput = String(body.location_id || "").trim();
	const metafieldInput = String(body.metafield_target || "").trim();

	const existing = await getDistanceSettings(c.env);
	const nextApiKey = apiKeyInput || existing.google_maps_api_key;

	if (!nextApiKey || !locationIdInput || !metafieldInput) {
		return c.redirect(
			redirectWithFlash(
				"/features/distance-calculation",
				"error",
				"Google Maps API Key, Location ID, and Order Metafield are required."
			)
		);
	}

	try {
		const resolvedMeta = await resolveMetafieldTarget(c.env, metafieldInput);
		const locationGid = normalizeLocationGid(locationIdInput);

		const toSave: Record<string, string> = {
			enabled: enabled ? "true" : "false",
			google_maps_api_key: nextApiKey,
			location_id: locationIdInput,
			metafield_namespace: resolvedMeta.namespace,
			metafield_key: resolvedMeta.key,
			metafield_raw: resolvedMeta.normalizedTarget,
		};

		let extraNote = "";
		try {
			const loc = await fetchShopifyLocationAddress(c.env, locationGid);
			toSave.warehouse_address_cache = loc.formattedAddress;
			toSave.warehouse_location_name = loc.name;
			toSave.warehouse_cached_location_id = loc.id;
			extraNote = ` Verified warehouse: ${loc.name} (${loc.formattedAddress}).`;
		} catch (locErr) {
			// Still save settings, but clear stale cache if location changed
			if (existing.warehouse_cached_location_id !== locationGid) {
				toSave.warehouse_address_cache = "";
				toSave.warehouse_location_name = "";
				toSave.warehouse_cached_location_id = "";
			}
			extraNote = ` Note: could not verify Location address yet (${
				locErr instanceof Error ? locErr.message : String(locErr)
			}).`;
		}

		await setSettings(
			c.env.DB,
			DISTANCE_SETTING_ID,
			toSave,
			DISTANCE_SECRET_KEYS,
			getEncryptionSecret(c.env)
		);

		return c.redirect(
			redirectWithFlash(
				"/features/distance-calculation",
				"success",
				`Saved Distance Calculation settings (target: ${resolvedMeta.normalizedTarget}).${extraNote}`
			)
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return c.redirect(redirectWithFlash("/features/distance-calculation", "error", msg));
	}
});

app.post("/features/distance-calculation/sync-webhooks", async (c) => {
	try {
		const webhookUrl = `${getAppBaseUrl(c.req.raw, c.env)}/webhooks/shopify/orders`;
		if (!webhookUrl.startsWith("https://")) {
			throw new Error(
				`Shopify requires an HTTPS webhook URL (current: ${webhookUrl}). Set APP_BASE_URL to your HTTPS tunnel or workers.dev URL.`
			);
		}
		const { created, existing } = await syncShopifyOrderWebhooks(c.env, webhookUrl);
		const parts: string[] = [];
		if (created.length > 0) {
			parts.push(`Registered: ${created.join(", ")}`);
		}
		if (existing.length > 0) {
			parts.push(`Already active: ${existing.join(", ")}`);
		}
		return c.redirect(
			redirectWithFlash(
				"/features/distance-calculation",
				"success",
				`Webhooks synced (${parts.join(" | ")}).`
			)
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return c.redirect(redirectWithFlash("/features/distance-calculation", "error", msg));
	}
});

app.post("/features/distance-calculation/test-order", async (c) => {
	const body = await c.req.parseBody();
	const orderId = String(body.order_id || "").trim();
	if (!orderId) {
		return c.redirect(
			redirectWithFlash("/features/distance-calculation", "error", "Please enter an Order ID.")
		);
	}

	try {
		const result = await runManualOrderDistanceCalculation(c.env, orderId);
		if (result.status === "success") {
			return c.redirect(
				redirectWithFlash("/features/distance-calculation", "success", result.message)
			);
		}
		return c.redirect(
			redirectWithFlash("/features/distance-calculation", "error", result.message)
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return c.redirect(redirectWithFlash("/features/distance-calculation", "error", msg));
	}
});
