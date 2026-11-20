import type { FC, PropsWithChildren } from "hono/jsx";
import type { SessionUser } from "../types";

interface LayoutProps {
	title: string;
	user?: SessionUser;
	flashSuccess?: string;
	flashError?: string;
	backHref?: string;
	backLabel?: string;
}

const styles = `
:root {
	--bg: #f6f7f9;
	--surface: #ffffff;
	--border: #e5e7eb;
	--text: #111827;
	--muted: #6b7280;
	--primary: #111827;
	--primary-hover: #1f2937;
	--accent: #2563eb;
	--success-bg: #ecfdf5;
	--success-text: #065f46;
	--success-border: #a7f3d0;
	--error-bg: #fef2f2;
	--error-text: #991b1b;
	--error-border: #fecaca;
	--warn-bg: #fffbeb;
	--warn-text: #92400e;
	--warn-border: #fde68a;
	--radius: 12px;
	--shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.04);
}
* { box-sizing: border-box; }
body {
	margin: 0;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	background: var(--bg);
	color: var(--text);
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar {
	background: var(--surface);
	border-bottom: 1px solid var(--border);
	position: sticky;
	top: 0;
	z-index: 10;
}
.topbar-inner {
	max-width: 1040px;
	margin: 0 auto;
	padding: 0 20px;
	height: 60px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
}
.brand {
	display: flex;
	align-items: center;
	gap: 10px;
	font-weight: 700;
	font-size: 16px;
	color: var(--text);
	text-decoration: none;
}
.brand:hover { text-decoration: none; }
.brand-badge {
	width: 30px;
	height: 30px;
	border-radius: 8px;
	background: var(--primary);
	color: #fff;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-size: 14px;
	font-weight: 700;
}
.user-bar {
	display: flex;
	align-items: center;
	gap: 12px;
	font-size: 13px;
	color: var(--muted);
}
.avatar {
	width: 28px;
	height: 28px;
	border-radius: 999px;
	object-fit: cover;
	border: 1px solid var(--border);
}
.container {
	max-width: 1040px;
	margin: 0 auto;
	padding: 28px 20px 56px;
}
.back-link {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
	font-weight: 500;
	color: var(--muted);
	margin-bottom: 16px;
}
.back-link:hover { color: var(--text); text-decoration: none; }
.page-header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 16px;
	margin-bottom: 24px;
	flex-wrap: wrap;
}
.page-title {
	margin: 0;
	font-size: 24px;
	font-weight: 700;
	letter-spacing: -0.02em;
}
.page-subtitle {
	margin: 4px 0 0;
	color: var(--muted);
	font-size: 14px;
}
.alert {
	padding: 12px 16px;
	border-radius: 10px;
	margin-bottom: 20px;
	font-size: 14px;
	border: 1px solid transparent;
}
.alert-success {
	background: var(--success-bg);
	color: var(--success-text);
	border-color: var(--success-border);
}
.alert-error {
	background: var(--error-bg);
	color: var(--error-text);
	border-color: var(--error-border);
}
.alert-warn {
	background: var(--warn-bg);
	color: var(--warn-text);
	border-color: var(--warn-border);
}
.card {
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	box-shadow: var(--shadow);
	padding: 22px;
	margin-bottom: 20px;
}
.card-title {
	margin: 0 0 4px;
	font-size: 16px;
	font-weight: 600;
}
.card-desc {
	margin: 0 0 18px;
	font-size: 13px;
	color: var(--muted);
}
.grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
	gap: 18px;
}
.feature-card {
	display: flex;
	flex-direction: column;
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	box-shadow: var(--shadow);
	padding: 22px;
	color: var(--text);
	text-decoration: none;
	transition: transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease;
}
.feature-card:hover {
	transform: translateY(-2px);
	box-shadow: 0 10px 24px rgba(16, 24, 40, 0.08);
	border-color: #d1d5db;
	text-decoration: none;
}
.feature-card-top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 16px;
}
.feature-icon {
	width: 48px;
	height: 48px;
	border-radius: 12px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: #fff;
}
.feature-title {
	margin: 0 0 6px;
	font-size: 17px;
	font-weight: 650;
}
.feature-desc {
	margin: 0;
	font-size: 13.5px;
	color: var(--muted);
	flex: 1;
}
.feature-footer {
	margin-top: 18px;
	padding-top: 12px;
	border-top: 1px solid #f3f4f6;
	font-size: 13px;
	font-weight: 500;
	color: var(--accent);
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.badge {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 3px 10px;
	border-radius: 999px;
	font-size: 12px;
	font-weight: 600;
}
.badge-success { background: var(--success-bg); color: var(--success-text); }
.badge-warn { background: var(--warn-bg); color: var(--warn-text); }
.badge-error { background: var(--error-bg); color: var(--error-text); }
.badge-neutral { background: #f3f4f6; color: #374151; }
.form-group { margin-bottom: 16px; }
label {
	display: block;
	font-size: 13.5px;
	font-weight: 600;
	margin-bottom: 6px;
}
.input {
	width: 100%;
	padding: 10px 12px;
	font-size: 14px;
	border: 1px solid #d1d5db;
	border-radius: 8px;
	background: #fff;
	color: var(--text);
	transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.input:focus {
	outline: none;
	border-color: var(--accent);
	box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
.help-text {
	margin: 5px 0 0;
	font-size: 12.5px;
	color: var(--muted);
}
.checkbox-row {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 14px;
	background: #f9fafb;
	border: 1px solid var(--border);
	border-radius: 8px;
	margin-bottom: 18px;
}
.checkbox-row input[type="checkbox"] {
	width: 18px;
	height: 18px;
	accent-color: #059669;
}
.checkbox-row label { margin: 0; cursor: pointer; }
.btn-row {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
	margin-top: 8px;
}
.btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	padding: 9px 16px;
	border-radius: 8px;
	font-size: 14px;
	font-weight: 600;
	border: 1px solid transparent;
	cursor: pointer;
	text-decoration: none;
	transition: background 0.12s ease, border-color 0.12s ease;
}
.btn:hover { text-decoration: none; }
.btn-primary {
	background: var(--primary);
	color: #fff;
}
.btn-primary:hover { background: var(--primary-hover); }
.btn-secondary {
	background: #fff;
	color: var(--text);
	border-color: #d1d5db;
}
.btn-secondary:hover { background: #f9fafb; }
.btn-sm { padding: 6px 12px; font-size: 13px; }
.mono {
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	font-size: 13px;
}
.code-box {
	background: #f3f4f6;
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 10px 12px;
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	font-size: 12.5px;
	word-break: break-all;
}
.kv-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 12px;
	margin-bottom: 16px;
}
.kv-item {
	background: #f9fafb;
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 12px 14px;
}
.kv-label {
	font-size: 12px;
	color: var(--muted);
	margin-bottom: 4px;
}
.kv-value {
	font-size: 14px;
	font-weight: 600;
	word-break: break-word;
}
.table-wrap { overflow-x: auto; }
table {
	width: 100%;
	border-collapse: collapse;
	font-size: 13px;
}
th, td {
	text-align: left;
	padding: 10px 12px;
	border-bottom: 1px solid var(--border);
	vertical-align: top;
}
th {
	font-size: 12px;
	text-transform: uppercase;
	letter-spacing: 0.03em;
	color: var(--muted);
	background: #f9fafb;
}
.login-shell {
	min-height: 100vh;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
}
.login-card {
	width: 100%;
	max-width: 440px;
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 16px;
	box-shadow: 0 12px 32px rgba(16, 24, 40, 0.08);
	padding: 32px;
}
`;

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
	title,
	user,
	flashSuccess,
	flashError,
	backHref,
	backLabel,
	children,
}) => {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title} — CHT Shopify Apps</title>
				<style dangerouslySetInnerHTML={{ __html: styles }} />
			</head>
			<body>
				{user && (
					<header class="topbar">
						<div class="topbar-inner">
							<a href="/" class="brand">
								<span class="brand-badge">C</span>
								<span>CHT Shopify Apps</span>
							</a>
							<div class="user-bar">
								{user.picture && <img class="avatar" src={user.picture} alt={user.name} />}
								<span>{user.email}</span>
								<form method="post" action="/auth/logout" style="margin:0;">
									<button type="submit" class="btn btn-secondary btn-sm">
										Sign Out
									</button>
								</form>
							</div>
						</div>
					</header>
				)}

				<main class={user ? "container" : ""}>
					{backHref && (
						<a href={backHref} class="back-link">
							← {backLabel || "Back to Dashboard"}
						</a>
					)}
					{flashSuccess && <div class="alert alert-success">{flashSuccess}</div>}
					{flashError && <div class="alert alert-error">{flashError}</div>}
					{children}
				</main>
			</body>
		</html>
	);
};
