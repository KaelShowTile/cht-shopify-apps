import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import { maskSecret } from "../lib/crypto";
import type { DistanceSettingsData } from "../features/distance-calculation";
import type { WebhookSubscriptionInfo } from "../lib/shopify";
import type { SessionUser, WebhookLogRow } from "../types";

interface DistanceSettingsPageProps {
	user: SessionUser;
	settings: DistanceSettingsData;
	webhookEndpointUrl: string;
	webhooks: WebhookSubscriptionInfo[];
	webhookListError?: string;
	logs: WebhookLogRow[];
	flashSuccess?: string;
	flashError?: string;
}

export const DistanceSettingsPage: FC<DistanceSettingsPageProps> = ({
	user,
	settings,
	webhookEndpointUrl,
	webhooks,
	webhookListError,
	logs,
	flashSuccess,
	flashError,
}) => {
	const paidSub = webhooks.find(
		(w) => w.topic === "ORDERS_PAID" && w.uri === webhookEndpointUrl
	);
	const updatedSub = webhooks.find(
		(w) => w.topic === "ORDERS_UPDATED" && w.uri === webhookEndpointUrl
	);

	return (
		<Layout
			title="Distance Calculation"
			user={user}
			backHref="/"
			backLabel="Back to App Features"
			flashSuccess={flashSuccess}
			flashError={flashError}
		>
			<div class="page-header">
				<div>
					<h1 class="page-title">Distance Calculation</h1>
					<p class="page-subtitle">
						Computes actual road driving distance (integer meters) via Google Maps Routes
						API and writes it to the order metafield on payment and post-payment address
						updates.
					</p>
				</div>
				<span class={`badge ${settings.enabled ? "badge-success" : "badge-neutral"}`}>
					{settings.enabled ? "Enabled" : "Disabled"}
				</span>
			</div>

			<div class="card">
				<h2 class="card-title">Feature Configuration</h2>
				<p class="card-desc">
					Stored in D1 (<span class="mono">setting_id = &quot;distance_calculation&quot;</span>).
				</p>

				<form method="post" action="/features/distance-calculation">
					<div class="checkbox-row">
						<input
							id="enabled"
							name="enabled"
							type="checkbox"
							value="true"
							checked={settings.enabled}
						/>
						<label for="enabled">
							Enable automatic distance calculation on paid orders &amp; address updates
						</label>
					</div>

					<div class="form-group">
						<label for="google_maps_api_key">Google Maps API Key (Routes API)</label>
						<input
							id="google_maps_api_key"
							name="google_maps_api_key"
							type="password"
							class="input mono"
							placeholder={
								settings.google_maps_api_key
									? `Saved (${maskSecret(settings.google_maps_api_key)}) — leave blank to keep`
									: "AIza..."
							}
							autocomplete="new-password"
						/>
						<p class="help-text">
							Make sure <strong>Routes API</strong> is enabled in Google Cloud Console.
							Restrict the key by API (not HTTP referrer or IP).
						</p>
					</div>

					<div class="form-group">
						<label for="location_id">Shopify Location ID (Warehouse)</label>
						<input
							id="location_id"
							name="location_id"
							type="text"
							class="input mono"
							placeholder="e.g. 98765432100 or gid://shopify/Location/98765432100"
							value={settings.location_id}
							required
						/>
						{settings.warehouse_address_cache ? (
							<p class="help-text">
								Resolved warehouse ({settings.warehouse_location_name || "Location"}):{" "}
								<strong>{settings.warehouse_address_cache}</strong>
							</p>
						) : (
							<p class="help-text">
								Find it in Shopify Admin → Settings → Locations (the numeric ID in the URL).
								Saving will automatically verify and cache the warehouse address.
							</p>
						)}
					</div>

					<div class="form-group">
						<label for="metafield_target">
							Order Metafield (<span class="mono">namespace.key</span> or Definition ID)
						</label>
						<input
							id="metafield_target"
							name="metafield_target"
							type="text"
							class="input mono"
							placeholder="e.g. custom.delivery_distance"
							value={settings.metafield_raw}
							required
						/>
						<p class="help-text">
							Target order metafield (<span class="mono">single_line_text_field</span>).
							Enter <span class="mono">namespace.key</span> (recommended) or a Shopify
							Metafield Definition ID (auto-resolved to{" "}
							<span class="mono">namespace.key</span> on save). Value is saved as integer
							meters (e.g. <span class="mono">14250</span>).
						</p>
					</div>

					<div class="btn-row">
						<button type="submit" class="btn btn-primary">
							Save Configuration
						</button>
					</div>
				</form>
			</div>

			<div class="card">
				<h2 class="card-title">Shopify Webhooks</h2>
				<p class="card-desc">
					Subscribes to <strong>ORDERS_PAID</strong> and <strong>ORDERS_UPDATED</strong>{" "}
					for automatic distance calculation and post-payment address changes.
				</p>

				<div class="form-group">
					<label>Webhook Endpoint URL</label>
					<div class="code-box">{webhookEndpointUrl}</div>
				</div>

				{webhookListError ? (
					<div class="alert alert-warn">{webhookListError}</div>
				) : (
					<div class="kv-grid">
						<div class="kv-item">
							<div class="kv-label">ORDERS_PAID</div>
							<div class="kv-value">
								<span class={`badge ${paidSub ? "badge-success" : "badge-warn"}`}>
									{paidSub ? "Subscribed" : "Not Registered"}
								</span>
							</div>
						</div>
						<div class="kv-item">
							<div class="kv-label">ORDERS_UPDATED (Address Changes)</div>
							<div class="kv-value">
								<span class={`badge ${updatedSub ? "badge-success" : "badge-warn"}`}>
									{updatedSub ? "Subscribed" : "Not Registered"}
								</span>
							</div>
						</div>
					</div>
				)}

				<form method="post" action="/features/distance-calculation/sync-webhooks">
					<button type="submit" class="btn btn-secondary">
						Register / Sync Webhooks
					</button>
				</form>
			</div>

			<div class="card">
				<h2 class="card-title">Manual Order Test / Recalculate</h2>
				<p class="card-desc">
					Enter an existing Shopify Order ID to immediately compute distance and write it to
					the configured metafield.
				</p>
				<form
					method="post"
					action="/features/distance-calculation/test-order"
					style="display:flex;gap:10px;flex-wrap:wrap;"
				>
					<input
						name="order_id"
						type="text"
						class="input mono"
						style="flex:1;min-width:240px;"
						placeholder="e.g. 6123456789012 or gid://shopify/Order/6123456789012"
						required
					/>
					<button type="submit" class="btn btn-secondary">
						Calculate Now
					</button>
				</form>
			</div>

			<div class="card">
				<h2 class="card-title">Recent Execution Logs</h2>
				<p class="card-desc">Latest 20 webhook &amp; manual distance calculation runs.</p>

				{logs.length === 0 ? (
					<p style="font-size:13.5px;color:var(--muted);margin:0;">
						No calculations recorded yet.
					</p>
				) : (
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Time (UTC)</th>
									<th>Order</th>
									<th>Trigger</th>
									<th>Destination</th>
									<th>Distance</th>
									<th>Status</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{logs.map((log) => (
									<tr key={log.id}>
										<td class="mono" style="white-space:nowrap;">
											{log.created_at}
										</td>
										<td class="mono">{log.order_name || log.order_id}</td>
										<td class="mono">{log.topic}</td>
										<td>{log.destination_address || "—"}</td>
										<td class="mono" style="white-space:nowrap;">
											{log.distance_meters !== null ? `${log.distance_meters} m` : "—"}
										</td>
										<td>
											<span
												class={`badge ${
													log.status === "success"
														? "badge-success"
														: log.status === "skipped"
															? "badge-neutral"
															: "badge-error"
												}`}
											>
												{log.status}
											</span>
										</td>
										<td>{log.message || "—"}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</Layout>
	);
};
