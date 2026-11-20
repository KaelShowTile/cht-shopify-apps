import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import worker from "../src/index";
import { signSessionToken } from "../src/lib/auth";
import { encryptValue, hmacSha256Base64 } from "../src/lib/crypto";
import { ensureSchema, getRecentWebhookLogs, getSettings, setSettings } from "../src/lib/db";
import { APP_SECRET_KEYS, APP_SETTING_ID } from "../src/lib/shopify";
import { DISTANCE_SECRET_KEYS, DISTANCE_SETTING_ID } from "../src/features/distance-calculation";
import type { AppBindings } from "../src/types";

const testEnv = env as AppBindings;

async function makeAdminCookie(email = "admin@example.com"): Promise<string> {
	const token = await signSessionToken(
		{
			email,
			name: "Test Admin",
			exp: Date.now() + 60 * 60 * 1000,
		},
		testEnv.SESSION_SECRET!
	);
	return `cht_session=${token}`;
}

async function callWorker(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, testEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("CHT Shopify Apps Worker", () => {
	beforeAll(async () => {
		await ensureSchema(testEnv.DB);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await testEnv.DB.batch([
			testEnv.DB.prepare("DELETE FROM settings"),
			testEnv.DB.prepare("DELETE FROM webhook_logs"),
		]);
	});

	it("redirects unauthenticated dashboard requests to /login and serves /health", async () => {
		const healthRes = await callWorker(new Request("https://app.example.com/health"));
		expect(healthRes.status).toBe(200);
		expect(await healthRes.json()).toEqual({ ok: true });

		const dashRes = await callWorker(new Request("https://app.example.com/"));
		expect(dashRes.status).toBe(302);
		expect(dashRes.headers.get("location")).toBe("/login?next=%2F");
	});

	it("renders dashboard grid for whitelisted Google user and blocks non-whitelisted users", async () => {
		const blockedCookie = await makeAdminCookie("stranger@example.com");
		const blockedRes = await callWorker(
			new Request("https://app.example.com/", {
				headers: { Cookie: blockedCookie },
			})
		);
		expect(blockedRes.status).toBe(302);
		expect(blockedRes.headers.get("location")).toContain("/login");

		const okCookie = await makeAdminCookie("admin@example.com");
		const okRes = await callWorker(
			new Request("https://app.example.com/", {
				headers: { Cookie: okCookie },
			})
		);
		expect(okRes.status).toBe(200);
		const html = await okRes.text();
		expect(html).toContain("App Settings");
		expect(html).toContain("Distance Calculation");
	});

	it("encrypts client_secret in D1 and preserves it when left blank on subsequent saves", async () => {
		const cookie = await makeAdminCookie();

		const form1 = new URLSearchParams({
			shop_domain: "https://my-test-shop.myshopify.com/",
			client_id: "client_123",
			client_secret: "shpss_super_secret",
		});
		const save1 = await callWorker(
			new Request("https://app.example.com/features/app-settings", {
				method: "POST",
				headers: {
					Cookie: cookie,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: form1.toString(),
			})
		);
		expect(save1.status).toBe(302);

		// Raw D1 row should be encrypted with enc:v1:
		const rawSecret = await testEnv.DB.prepare(
			"SELECT value FROM settings WHERE setting_id = 'app' AND key = 'client_secret'"
		).first<{ value: string }>();
		expect(rawSecret?.value.startsWith("enc:v1:")).toBe(true);

		// Saving again with blank secret preserves previous secret
		const form2 = new URLSearchParams({
			shop_domain: "my-test-shop.myshopify.com",
			client_id: "client_456",
			client_secret: "",
		});
		await callWorker(
			new Request("https://app.example.com/features/app-settings", {
				method: "POST",
				headers: {
					Cookie: cookie,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: form2.toString(),
			})
		);

		const decrypted = await getSettings(testEnv.DB, APP_SETTING_ID, testEnv.ENCRYPTION_KEY);
		expect(decrypted.shop_domain).toBe("my-test-shop.myshopify.com");
		expect(decrypted.client_id).toBe("client_456");
		expect(decrypted.client_secret).toBe("shpss_super_secret");
	});

	it("processes orders/paid webhook, caches 24h token, skips unchanged orders/updated, and recalculates when address changes", async () => {
		const clientSecret = "shpss_webhook_secret_key";
		await setSettings(
			testEnv.DB,
			APP_SETTING_ID,
			{
				shop_domain: "demo-store.myshopify.com",
				client_id: "demo_client_id",
				client_secret: clientSecret,
			},
			APP_SECRET_KEYS,
			testEnv.ENCRYPTION_KEY
		);
		await setSettings(
			testEnv.DB,
			DISTANCE_SETTING_ID,
			{
				enabled: "true",
				google_maps_api_key: "AIza_test_key",
				location_id: "11223344",
				metafield_namespace: "custom",
				metafield_key: "delivery_distance",
				metafield_raw: "custom.delivery_distance",
			},
			DISTANCE_SECRET_KEYS,
			testEnv.ENCRYPTION_KEY
		);

		// Reject invalid HMAC
		const badRes = await callWorker(
			new Request("https://app.example.com/webhooks/shopify/orders", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-shopify-topic": "orders/paid",
					"x-shopify-hmac-sha256": "invalid-hmac",
				},
				body: JSON.stringify({ id: 9001 }),
			})
		);
		expect(badRes.status).toBe(401);

		let tokenCalls = 0;
		let locationCalls = 0;
		let googleCalls = 0;
		const savedValues: string[] = [];

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

			if (url === "https://demo-store.myshopify.com/admin/oauth/access_token") {
				tokenCalls++;
				return Response.json({
					access_token: "shpca_24h_test_token",
					expires_in: 86399,
				});
			}

			if (url === "https://demo-store.myshopify.com/admin/api/2026-04/graphql.json") {
				const body = JSON.parse(String(init?.body || "{}")) as {
					query: string;
					variables?: {
						metafields?: Array<{
							type: string;
							namespace: string;
							key: string;
							value: string;
						}>;
					};
				};

				if (body.query.includes("GetLocationAddress")) {
					locationCalls++;
					return Response.json({
						data: {
							location: {
								id: "gid://shopify/Location/11223344",
								name: "Main Warehouse",
								address: {
									formatted: ["100 Warehouse Rd, Sydney NSW 2000, Australia"],
								},
							},
						},
					});
				}

				if (body.query.includes("metafieldsSet")) {
					const mf = body.variables!.metafields![0];
					expect(mf.type).toBe("single_line_text_field");
					expect(mf.namespace).toBe("custom");
					expect(mf.key).toBe("delivery_distance");
					savedValues.push(mf.value);
					return Response.json({
						data: {
							metafieldsSet: {
								metafields: [
									{
										id: "gid://shopify/Metafield/1",
										namespace: mf.namespace,
										key: mf.key,
										value: mf.value,
									},
								],
								userErrors: [],
							},
						},
					});
				}
			}

			if (url === "https://routes.googleapis.com/directions/v2:computeRoutes") {
				googleCalls++;
				const distance = googleCalls === 1 ? 15432.6 : 28900.2;
				return Response.json({
					routes: [{ distanceMeters: distance }],
				});
			}

			throw new Error(`Unexpected outbound fetch: ${url}`);
		});

		const paidPayload = JSON.stringify({
			id: 5550001,
			admin_graphql_api_id: "gid://shopify/Order/5550001",
			name: "#1001",
			financial_status: "paid",
			shipping_address: {
				address1: "1 Martin Pl",
				city: "Sydney",
				province_code: "NSW",
				zip: "2000",
				country: "Australia",
			},
		});
		const paidHmac = await hmacSha256Base64(paidPayload, clientSecret);

		const paidRes = await callWorker(
			new Request("https://app.example.com/webhooks/shopify/orders", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-shopify-topic": "orders/paid",
					"x-shopify-webhook-id": "wh_paid_1",
					"x-shopify-hmac-sha256": paidHmac,
				},
				body: paidPayload,
			})
		);
		expect(paidRes.status).toBe(200);
		expect(savedValues).toEqual(["15433"]);
		expect(tokenCalls).toBe(1);
		expect(locationCalls).toBe(1);
		expect(googleCalls).toBe(1);

		// Verify 24h token was cached in D1
		const cachedApp = await getSettings(testEnv.DB, APP_SETTING_ID, testEnv.ENCRYPTION_KEY);
		expect(cachedApp.access_token).toBe("shpca_24h_test_token");

		// 1) Duplicate webhook_id should NOT call Google or Shopify again
		await callWorker(
			new Request("https://app.example.com/webhooks/shopify/orders", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-shopify-topic": "orders/paid",
					"x-shopify-webhook-id": "wh_paid_1",
					"x-shopify-hmac-sha256": paidHmac,
				},
				body: paidPayload,
			})
		);
		expect(googleCalls).toBe(1);

		// 2) orders/updated with SAME shipping address (e.g. triggered by our metafield write) must NOT recalculate
		await callWorker(
			new Request("https://app.example.com/webhooks/shopify/orders", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-shopify-topic": "orders/updated",
					"x-shopify-webhook-id": "wh_upd_same_1",
					"x-shopify-hmac-sha256": paidHmac,
				},
				body: paidPayload,
			})
		);
		expect(googleCalls).toBe(1);

		// 3) orders/updated with UNPAID status must be ignored
		const unpaidPayload = JSON.stringify({
			id: 5550002,
			name: "#1002",
			financial_status: "pending",
			shipping_address: { address1: "99 George St", city: "Sydney", country: "Australia" },
		});
		const unpaidHmac = await hmacSha256Base64(unpaidPayload, clientSecret);
		await callWorker(
			new Request("https://app.example.com/webhooks/shopify/orders", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-shopify-topic": "orders/updated",
					"x-shopify-webhook-id": "wh_upd_unpaid_1",
					"x-shopify-hmac-sha256": unpaidHmac,
				},
				body: unpaidPayload,
			})
		);
		expect(googleCalls).toBe(1);

		// 4) orders/updated with CHANGED shipping address on paid order MUST recalculate (using cached token & warehouse!)
		const changedAddressPayload = JSON.stringify({
			id: 5550001,
			admin_graphql_api_id: "gid://shopify/Order/5550001",
			name: "#1001",
			financial_status: "paid",
			shipping_address: {
				address1: "500 Parramatta Rd",
				city: "Parramatta",
				province_code: "NSW",
				zip: "2150",
				country: "Australia",
			},
		});
		const changedHmac = await hmacSha256Base64(changedAddressPayload, clientSecret);
		await callWorker(
			new Request("https://app.example.com/webhooks/shopify/orders", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-shopify-topic": "orders/updated",
					"x-shopify-webhook-id": "wh_upd_changed_1",
					"x-shopify-hmac-sha256": changedHmac,
				},
				body: changedAddressPayload,
			})
		);

		expect(savedValues).toEqual(["15433", "28900"]);
		expect(tokenCalls).toBe(1); // Reused cached 24h token
		expect(locationCalls).toBe(1); // Reused cached warehouse address
		expect(googleCalls).toBe(2);

		// 5) Digital / local pickup order without shipping_address is skipped cleanly
		const noAddrPayload = JSON.stringify({
			id: 5550003,
			name: "#1003",
			financial_status: "paid",
			shipping_address: null,
		});
		const noAddrHmac = await hmacSha256Base64(noAddrPayload, clientSecret);
		await callWorker(
			new Request("https://app.example.com/webhooks/shopify/orders", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-shopify-topic": "orders/paid",
					"x-shopify-webhook-id": "wh_no_addr_1",
					"x-shopify-hmac-sha256": noAddrHmac,
				},
				body: noAddrPayload,
			})
		);
		expect(googleCalls).toBe(2);

		const logs = await getRecentWebhookLogs(testEnv.DB, DISTANCE_SETTING_ID, 10);
		expect(logs.length).toBe(3);
		expect(logs[0].status).toBe("skipped");
		expect(logs[1].distance_meters).toBe(28900);
		expect(logs[1].topic).toBe("orders/updated");
		expect(logs[2].distance_meters).toBe(15433);
		expect(logs[2].topic).toBe("orders/paid");
	});

	it("surfaces decryption mismatch warning with key fingerprint and supports SESSION_SECRET fallback", async () => {
		const cookie = await makeAdminCookie();

		// 1) Value encrypted with a completely different key should trigger clear UI warning
		const foreignCiphertext = await encryptValue("shpss_other_env", "completely-different-key");
		await testEnv.DB.prepare(
			"INSERT INTO settings (setting_id, key, value) VALUES ('app', 'client_secret', ?)"
		)
			.bind(foreignCiphertext)
			.run();

		const warnRes = await callWorker(
			new Request("https://app.example.com/features/app-settings", {
				headers: { Cookie: cookie },
			})
		);
		expect(warnRes.status).toBe(200);
		const warnHtml = await warnRes.text();
		expect(warnHtml).toContain("Decryption failed");
		expect(warnHtml).toContain("client_secret");

		// 2) Value encrypted with SESSION_SECRET should decrypt via fallback even when ENCRYPTION_KEY is set
		const sessionKeyCiphertext = await encryptValue("shpss_legacy_session", testEnv.SESSION_SECRET!);
		await testEnv.DB.prepare(
			"UPDATE settings SET value = ? WHERE setting_id = 'app' AND key = 'client_secret'"
		)
			.bind(sessionKeyCiphertext)
			.run();

		const okRes = await callWorker(
			new Request("https://app.example.com/features/app-settings", {
				headers: { Cookie: cookie },
			})
		);
		const okHtml = await okRes.text();
		expect(okHtml).not.toContain("Decryption failed");
		expect(okHtml).toContain("Saved (••••••••sion)");
	});
});
