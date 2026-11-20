import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			miniflare: {
				bindings: {
					GOOGLE_CLIENT_ID: "test-google-client-id",
					GOOGLE_CLIENT_SECRET: "test-google-client-secret",
					ALLOWED_EMAILS: "admin@example.com",
					SESSION_SECRET: "test-session-secret-32-chars-minimum-key",
					ENCRYPTION_KEY: "test-encryption-key-32-chars-minimum-key",
				},
			},
		}),
	],
});
