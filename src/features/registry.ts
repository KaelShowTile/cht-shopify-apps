import type { FeatureDefinition } from "../types";

export const FEATURES: FeatureDefinition[] = [
	{
		id: "app",
		title: "App Settings",
		subtitle: "Core Connection",
		description:
			"Configure Shopify Store Domain, Dev Dashboard Client ID & Client Secret, and manage 24h Admin API access tokens.",
		href: "/features/app-settings",
		icon: "settings",
		accent: "#2563eb",
	},
	{
		id: "distance_calculation",
		title: "Distance Calculation",
		subtitle: "Order Logistics",
		description:
			"Automatically calculate driving distance (in meters) from warehouse to shipping address when orders are paid or addresses change.",
		href: "/features/distance-calculation",
		icon: "route",
		accent: "#059669",
	},
];
