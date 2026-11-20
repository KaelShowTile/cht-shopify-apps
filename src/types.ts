export interface AppBindings extends Env {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	ALLOWED_EMAILS?: string;
	SESSION_SECRET?: string;
	ENCRYPTION_KEY?: string;
	APP_BASE_URL?: string;
}

export interface SessionUser {
	email: string;
	name: string;
	picture?: string;
	exp: number;
}

export interface AppVariables {
	user: SessionUser;
}

export type HonoAppEnv = {
	Bindings: AppBindings;
	Variables: AppVariables;
};

export interface FeatureDefinition {
	id: string;
	title: string;
	subtitle: string;
	description: string;
	href: string;
	icon: string;
	accent: string;
}

export interface ShopifyAddress {
	address1?: string | null;
	address2?: string | null;
	city?: string | null;
	province?: string | null;
	province_code?: string | null;
	provinceCode?: string | null;
	zip?: string | null;
	country?: string | null;
	country_code?: string | null;
	countryCode?: string | null;
	countryCodeV2?: string | null;
	formatted?: string[] | null;
}

export interface ShopifyOrderWebhookPayload {
	id: number | string;
	admin_graphql_api_id?: string;
	name?: string;
	financial_status?: string | null;
	shipping_address?: ShopifyAddress | null;
}

export interface WebhookLogRow {
	id: number;
	feature: string;
	webhook_id: string | null;
	topic: string;
	order_id: string;
	order_name: string | null;
	address_hash: string | null;
	destination_address: string | null;
	distance_meters: number | null;
	status: "success" | "skipped" | "error";
	message: string | null;
	created_at: string;
}
