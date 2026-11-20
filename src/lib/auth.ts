import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import {
	base64UrlToBytes,
	bytesToBase64Url,
	hmacSha256Base64Url,
	randomToken,
	timingSafeEqualString,
} from "./crypto";
import type { AppBindings, HonoAppEnv, SessionUser } from "../types";

const SESSION_COOKIE = "cht_session";
const OAUTH_STATE_COOKIE = "cht_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const OAUTH_STATE_TTL_SECONDS = 60 * 10; // 10 minutes

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function getAppBaseUrl(request: Request, env: AppBindings): string {
	if (env.APP_BASE_URL && env.APP_BASE_URL.trim()) {
		return env.APP_BASE_URL.trim().replace(/\/+$/, "");
	}
	return new URL(request.url).origin;
}

export function isRequestSecure(request: Request): boolean {
	return new URL(request.url).protocol === "https:";
}

export function isOAuthConfigured(env: AppBindings): boolean {
	return Boolean(
		env.GOOGLE_CLIENT_ID &&
			env.GOOGLE_CLIENT_SECRET &&
			env.ALLOWED_EMAILS &&
			env.SESSION_SECRET
	);
}

export function parseAllowedEmails(raw?: string): Set<string> {
	if (!raw) {
		return new Set();
	}
	return new Set(
		raw
			.split(/[,;\s]+/)
			.map((item) => item.trim().toLowerCase())
			.filter(Boolean)
	);
}

export function isEmailAllowed(email: string, rawWhitelist?: string): boolean {
	const allowed = parseAllowedEmails(rawWhitelist);
	return allowed.has(email.trim().toLowerCase());
}

export async function signSessionToken(user: SessionUser, secret: string): Promise<string> {
	const payload = bytesToBase64Url(encoder.encode(JSON.stringify(user)));
	const signature = await hmacSha256Base64Url(payload, secret);
	return `${payload}.${signature}`;
}

export async function verifySessionToken(
	token: string | undefined,
	secret: string | undefined
): Promise<SessionUser | null> {
	if (!token || !secret) {
		return null;
	}
	const parts = token.split(".");
	if (parts.length !== 2) {
		return null;
	}
	const [payload, signature] = parts;
	const expected = await hmacSha256Base64Url(payload, secret);
	if (!timingSafeEqualString(signature, expected)) {
		return null;
	}
	try {
		const decoded = JSON.parse(decoder.decode(base64UrlToBytes(payload))) as SessionUser;
		if (!decoded.email || typeof decoded.exp !== "number") {
			return null;
		}
		if (Date.now() > decoded.exp) {
			return null;
		}
		return decoded;
	} catch {
		return null;
	}
}

export async function createSession(
	c: Context<HonoAppEnv>,
	user: Omit<SessionUser, "exp">
): Promise<void> {
	const secret = c.env.SESSION_SECRET;
	if (!secret) {
		throw new Error("SESSION_SECRET is not configured");
	}
	const sessionUser: SessionUser = {
		...user,
		exp: Date.now() + SESSION_TTL_SECONDS * 1000,
	};
	const token = await signSessionToken(sessionUser, secret);
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		secure: isRequestSecure(c.req.raw),
		sameSite: "Lax",
		path: "/",
		maxAge: SESSION_TTL_SECONDS,
	});
}

export function clearSession(c: Context<HonoAppEnv>): void {
	deleteCookie(c, SESSION_COOKIE, {
		path: "/",
		httpOnly: true,
		secure: isRequestSecure(c.req.raw),
		sameSite: "Lax",
	});
}

export function sanitizeNextPath(nextPath?: string | null): string {
	if (!nextPath || !nextPath.startsWith("/") || nextPath.startsWith("//")) {
		return "/";
	}
	return nextPath;
}

export function initiateGoogleOAuth(c: Context<HonoAppEnv>): string {
	const clientId = c.env.GOOGLE_CLIENT_ID;
	if (!clientId) {
		throw new Error("GOOGLE_CLIENT_ID is not configured");
	}
	const state = randomToken(24);
	const nextPath = sanitizeNextPath(c.req.query("next"));
	const statePayload = JSON.stringify({ state, next: nextPath });

	setCookie(c, OAUTH_STATE_COOKIE, bytesToBase64Url(encoder.encode(statePayload)), {
		httpOnly: true,
		secure: isRequestSecure(c.req.raw),
		sameSite: "Lax",
		path: "/",
		maxAge: OAUTH_STATE_TTL_SECONDS,
	});

	const redirectUri = `${getAppBaseUrl(c.req.raw, c.env)}/auth/callback`;
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: "openid email profile",
		state,
		prompt: "select_account",
	});

	return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function consumeOAuthState(
	c: Context<HonoAppEnv>,
	returnedState?: string
): { valid: boolean; next: string } {
	const raw = getCookie(c, OAUTH_STATE_COOKIE);
	deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
	if (!raw || !returnedState) {
		return { valid: false, next: "/" };
	}
	try {
		const parsed = JSON.parse(decoder.decode(base64UrlToBytes(raw))) as {
			state?: string;
			next?: string;
		};
		if (!parsed.state || !timingSafeEqualString(parsed.state, returnedState)) {
			return { valid: false, next: "/" };
		}
		return { valid: true, next: sanitizeNextPath(parsed.next) };
	} catch {
		return { valid: false, next: "/" };
	}
}

export interface GoogleUserInfo {
	email: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
}

export async function exchangeGoogleCodeForUser(
	code: string,
	redirectUri: string,
	clientId: string,
	clientSecret: string
): Promise<GoogleUserInfo> {
	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}).toString(),
	});

	if (!tokenRes.ok) {
		const text = await tokenRes.text();
		throw new Error(`Google token exchange failed (${tokenRes.status}): ${text}`);
	}

	const tokenData = (await tokenRes.json()) as { access_token?: string };
	if (!tokenData.access_token) {
		throw new Error("Google token response did not include access_token");
	}

	const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
		headers: { Authorization: `Bearer ${tokenData.access_token}` },
	});

	if (!userRes.ok) {
		const text = await userRes.text();
		throw new Error(`Google userinfo fetch failed (${userRes.status}): ${text}`);
	}

	const user = (await userRes.json()) as GoogleUserInfo;
	if (!user.email) {
		throw new Error("Google account did not return an email address");
	}
	return user;
}

export const requireAuth: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
	const token = getCookie(c, SESSION_COOKIE);
	const user = await verifySessionToken(token, c.env.SESSION_SECRET);

	if (!user || !isEmailAllowed(user.email, c.env.ALLOWED_EMAILS)) {
		if (c.req.path.startsWith("/api/")) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const url = new URL(c.req.url);
		const nextParam = encodeURIComponent(`${url.pathname}${url.search}`);
		return c.redirect(`/login?next=${nextParam}`);
	}

	c.set("user", user);
	await next();
};
