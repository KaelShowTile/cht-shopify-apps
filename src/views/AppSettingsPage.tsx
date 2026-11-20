import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import { maskSecret } from "../lib/crypto";
import type { AppSettingsData } from "../lib/shopify";
import type { SessionUser } from "../types";

interface AppSettingsPageProps {
	user: SessionUser;
	settings: AppSettingsData;
	keyFingerprint: string;
	flashSuccess?: string;
	flashError?: string;
}

export const AppSettingsPage: FC<AppSettingsPageProps> = ({
	user,
	settings,
	keyFingerprint,
	flashSuccess,
	flashError,
}) => {
	const expiresAtNum = Number(settings.access_token_expires_at || "0");
	const hasValidToken =
		Boolean(settings.access_token) && Number.isFinite(expiresAtNum) && expiresAtNum > Date.now();
	const expiresLabel = hasValidToken ? new Date(expiresAtNum).toISOString() : "Not active";

	return (
		<Layout
			title="App Settings"
			user={user}
			backHref="/"
			backLabel="Back to App Features"
			flashSuccess={flashSuccess}
			flashError={flashError}
		>
			<div class="page-header">
				<div>
					<h1 class="page-title">App Settings</h1>
					<p class="page-subtitle">
						Shopify Dev Dashboard custom app credentials and automatic 24-hour Admin API
						token caching.
					</p>
				</div>
				<span class={`badge ${hasValidToken ? "badge-success" : "badge-warn"}`}>
					{hasValidToken ? "Token Active" : "Token Not Fetched"}
				</span>
			</div>

			{settings.decryptionErrors.length > 0 && (
				<div class="alert alert-error">
					<strong>Decryption failed</strong> for stored field(s):{" "}
					<span class="mono">{settings.decryptionErrors.join(", ")}</span>. This happens
					when <span class="mono">ENCRYPTION_KEY</span> does not match the key used when
					those values were saved (for example, local <span class="mono">.dev.vars</span> vs
					Cloudflare Dashboard Secrets mismatch, or extra quotes/spaces). Active key
					fingerprint: <span class="mono">{keyFingerprint}</span>. Please make sure both
					environments share the exact same <span class="mono">ENCRYPTION_KEY</span>, then
					re-save the secret.
				</div>
			)}

			<div class="card">
				<h2 class="card-title">Shopify Credentials</h2>
				<p class="card-desc">
					Stored in D1 (<span class="mono">setting_id = &quot;app&quot;</span>). Client Secret
					and Access Token are encrypted with AES-GCM (active key fingerprint:{" "}
					<span class="mono">{keyFingerprint}</span>).
				</p>

				<form method="post" action="/features/app-settings">
					<div class="form-group">
						<label for="shop_domain">Shopify Store Domain</label>
						<input
							id="shop_domain"
							name="shop_domain"
							type="text"
							class="input"
							placeholder="your-store.myshopify.com"
							value={settings.shop_domain}
							required
						/>
						<p class="help-text">
							Use the permanent <span class="mono">.myshopify.com</span> domain (without{" "}
							<span class="mono">https://</span>).
						</p>
					</div>

					<div class="form-group">
						<label for="client_id">Client ID</label>
						<input
							id="client_id"
							name="client_id"
							type="text"
							class="input mono"
							placeholder="Shopify Dev Dashboard Client ID"
							value={settings.client_id}
							required
						/>
					</div>

					<div class="form-group">
						<label
							for="client_secret"
							style="display:flex;align-items:center;justify-content:space-between;gap:8px;"
						>
							<span>Client Secret</span>
							{settings.client_secret && (
								<span class="badge badge-success mono">
									Saved ({maskSecret(settings.client_secret)})
								</span>
							)}
						</label>
						<input
							id="client_secret"
							name="client_secret"
							type="password"
							class="input mono"
							placeholder={
								settings.client_secret
									? `Saved (${maskSecret(settings.client_secret)}) — leave blank to keep`
									: "Shopify Dev Dashboard Client Secret"
							}
							autocomplete="new-password"
						/>
						<p class="help-text">
							Used for both Client Credentials Grant token requests and Webhook HMAC-SHA256
							verification.
						</p>
					</div>

					<div class="btn-row">
						<button type="submit" class="btn btn-primary">
							Save Settings
						</button>
					</div>
				</form>
			</div>

			<div class="card">
				<h2 class="card-title">24-Hour Admin API Access Token</h2>
				<p class="card-desc">
					Automatically fetched via <span class="mono">grant_type=client_credentials</span>{" "}
					and refreshed proactively before expiration (or on HTTP 401).
				</p>

				<div class="kv-grid">
					<div class="kv-item">
						<div class="kv-label">Cached Token</div>
						<div class="kv-value mono">
							{settings.access_token ? maskSecret(settings.access_token) : "—"}
						</div>
					</div>
					<div class="kv-item">
						<div class="kv-label">Expires At (UTC)</div>
						<div class="kv-value mono">{expiresLabel}</div>
					</div>
				</div>

				<form method="post" action="/features/app-settings/test-token">
					<button type="submit" class="btn btn-secondary">
						Test Connection &amp; Refresh Token
					</button>
				</form>
			</div>
		</Layout>
	);
};
