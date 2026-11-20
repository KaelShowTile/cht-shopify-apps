import type { FC } from "hono/jsx";
import { Layout } from "./Layout";

interface LoginPageProps {
	oauthConfigured: boolean;
	callbackUrl: string;
	nextPath: string;
	errorMessage?: string;
}

export const LoginPage: FC<LoginPageProps> = ({
	oauthConfigured,
	callbackUrl,
	nextPath,
	errorMessage,
}) => {
	const authHref = `/auth/google?next=${encodeURIComponent(nextPath)}`;

	return (
		<Layout title="Sign In">
			<div class="login-shell">
				<div class="login-card">
					<div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
						<span class="brand-badge" style="width:38px;height:38px;font-size:17px;">
							C
						</span>
						<div>
							<h1 style="margin:0;font-size:20px;">CHT Shopify Apps</h1>
							<p style="margin:2px 0 0;font-size:13px;color:var(--muted);">
								Admin Console
							</p>
						</div>
					</div>

					{errorMessage && <div class="alert alert-error">{errorMessage}</div>}

					{oauthConfigured ? (
						<div>
							<p style="font-size:14px;color:var(--muted);margin:0 0 22px;">
								Sign in with an authorized Google account to manage Shopify app
								credentials and custom automation features.
							</p>
							<a
								href={authHref}
								class="btn btn-primary"
								style="width:100%;padding:11px 16px;"
							>
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
									<path
										fill="#EA4335"
										d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.1.8 3.9 1.5l2.6-2.5C16.8 3.4 14.6 2.5 12 2.5 6.8 2.5 2.5 6.8 2.5 12s4.3 9.5 9.5 9.5c5.5 0 9.1-3.9 9.1-9.3 0-.6-.1-1.1-.2-1.6H12z"
									/>
								</svg>
								<span>Continue with Google</span>
							</a>
						</div>
					) : (
						<div>
							<div class="alert alert-warn" style="margin-bottom:14px;">
								Google OAuth environment variables are not configured yet.
							</div>
							<p style="font-size:13px;color:var(--muted);margin:0 0 10px;">
								Set the following secrets in <span class="mono">.dev.vars</span> (local)
								or via <span class="mono">npx wrangler secret put</span> (production):
							</p>
							<div class="code-box" style="margin-bottom:12px;">
								GOOGLE_CLIENT_ID{"\n"}
								<br />
								GOOGLE_CLIENT_SECRET
								<br />
								ALLOWED_EMAILS
								<br />
								SESSION_SECRET
							</div>
							<p style="font-size:12.5px;color:var(--muted);margin:0;">
								Authorized Redirect URI for Google Cloud Console:
							</p>
							<div class="code-box" style="margin-top:6px;">
								{callbackUrl}
							</div>
						</div>
					)}
				</div>
			</div>
		</Layout>
	);
};
