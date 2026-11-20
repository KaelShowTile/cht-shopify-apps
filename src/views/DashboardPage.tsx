import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import type { FeatureDefinition, SessionUser } from "../types";

export interface FeatureStatusSummary {
	label: string;
	tone: "success" | "warn" | "neutral";
}

interface DashboardPageProps {
	user: SessionUser;
	features: FeatureDefinition[];
	statuses: Record<string, FeatureStatusSummary>;
	shopDomain?: string;
}

const FeatureIcon: FC<{ name: string }> = ({ name }) => {
	if (name === "settings") {
		return (
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
			</svg>
		);
	}
	if (name === "route") {
		return (
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="6" cy="19" r="3" />
				<path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
				<circle cx="18" cy="5" r="3" />
			</svg>
		);
	}
	return (
		<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<rect x="4" y="4" width="16" height="16" rx="3" />
		</svg>
	);
};

export const DashboardPage: FC<DashboardPageProps> = ({
	user,
	features,
	statuses,
	shopDomain,
}) => {
	return (
		<Layout title="Dashboard" user={user}>
			<div class="page-header">
				<div>
					<h1 class="page-title">App Features</h1>
					<p class="page-subtitle">
						{shopDomain
							? `Connected store: ${shopDomain}`
							: "Select a module below to configure your Shopify custom app."}
					</p>
				</div>
			</div>

			<div class="grid">
				{features.map((feature) => {
					const status = statuses[feature.id] || {
						label: "Needs Setup",
						tone: "warn" as const,
					};
					return (
						<a href={feature.href} class="feature-card" key={feature.id}>
							<div class="feature-card-top">
								<div class="feature-icon" style={`background:${feature.accent};`}>
									<FeatureIcon name={feature.icon} />
								</div>
								<span class={`badge badge-${status.tone}`}>{status.label}</span>
							</div>
							<h2 class="feature-title">{feature.title}</h2>
							<p class="feature-desc">{feature.description}</p>
							<div class="feature-footer">
								<span>{feature.subtitle}</span>
								<span>Open →</span>
							</div>
						</a>
					);
				})}
			</div>
		</Layout>
	);
};
