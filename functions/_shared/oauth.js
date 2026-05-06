const PROVIDERS = {
  discord: {
    clientId: "DISCORD_CLIENT_ID",
    clientSecret: "DISCORD_CLIENT_SECRET",
    redirectUri: "DISCORD_REDIRECT_URI",
    scopes: "DISCORD_SCOPES",
    defaultScopes: "identify email",
    stateCookie: "discord_oauth_state",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    userUrl: "https://discord.com/api/users/@me"
  },
  google: {
    clientId: "GOOGLE_CLIENT_ID",
    clientSecret: "GOOGLE_CLIENT_SECRET",
    redirectUri: "GOOGLE_REDIRECT_URI",
    scopes: "GOOGLE_SCOPES",
    defaultScopes: "openid email profile",
    stateCookie: "google_oauth_state",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userUrl: "https://openidconnect.googleapis.com/v1/userinfo"
  }
};

const SESSION_COOKIE = "market_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const STATE_SECONDS = 60 * 10;

export async function handleConfig(context) {
  const url = new URL(context.request.url);
  const discord = providerSettings(context.env, "discord", url);
  const google = providerSettings(context.env, "google", url);

  return json({
    discordConfigured: discord.configured,
    googleConfigured: google.configured,
    sessionSecretConfigured: hasRealValue(getEnv(context.env, "SESSION_SECRET")),
    authRequired: true,
    providers: {
      discord: {
        configured: discord.configured,
        scopes: discord.scopes,
        redirectUri: discord.redirectUri
      },
      google: {
        configured: google.configured,
        scopes: google.scopes,
        redirectUri: google.redirectUri
      }
    },
    scopes: discord.scopes,
    redirectUri: discord.redirectUri
  });
}

export async function handleMe(context) {
  const session = await readSession(context.request, context.env);

  return json({
    authenticated: Boolean(session),
    user: session ? session.user : null
  });
}

export async function handleLogout(context) {
  const url = new URL(context.request.url);
  const returnTo = safeReturnUrl(url.searchParams.get("returnTo"), context.request, context.env);
  const headers = new Headers({ Location: returnTo, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
  return new Response(null, { status: 302, headers });
}

export async function handleOAuthStart(context, provider) {
  const requestUrl = new URL(context.request.url);
  const settings = providerSettings(context.env, provider, requestUrl);
  const returnTo = safeReturnUrl(
    requestUrl.searchParams.get("returnTo"),
    context.request,
    context.env
  );

  if (!settings.configured) {
    return redirect(authRedirect(returnTo, `${provider}_not_configured`));
  }

  const csrf = randomToken(24);
  const statePayload = encodePayload({
    csrf,
    provider,
    returnTo,
    expiresAt: Date.now() + STATE_SECONDS * 1000
  });
  const stateCookie = await packSigned(statePayload, context.env);
  const authUrl = new URL(settings.authorizeUrl);

  authUrl.searchParams.set("client_id", settings.clientId);
  authUrl.searchParams.set("redirect_uri", settings.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", settings.scopes);
  authUrl.searchParams.set("state", csrf);

  if (provider === "google") {
    authUrl.searchParams.set("prompt", "select_account");
  }

  return redirect(authUrl.toString(), [
    serializeCookie(settings.stateCookie, stateCookie, {
      maxAge: STATE_SECONDS,
      path: `/auth/${provider}`,
      secure: requestUrl.protocol === "https:"
    })
  ]);
}

export async function handleOAuthCallback(context, provider) {
  const requestUrl = new URL(context.request.url);
  const settings = providerSettings(context.env, provider, requestUrl);
  const code = requestUrl.searchParams.get("code");
  const returnedState = requestUrl.searchParams.get("state");
  const cookies = parseCookies(context.request);
  const clearStateCookie = clearCookie(settings.stateCookie, `/auth/${provider}`);
  const pending = cookies[settings.stateCookie]
    ? await unpackPayload(cookies[settings.stateCookie], context.env)
    : null;

  if (
    !code ||
    !returnedState ||
    !pending ||
    pending.provider !== provider ||
    pending.csrf !== returnedState ||
    pending.expiresAt < Date.now()
  ) {
    const returnTo = pending ? pending.returnTo : requestUrl.origin;
    return redirect(authRedirect(returnTo, "state_error"), [clearStateCookie]);
  }

  try {
    const token = await fetchToken(settings, code);
    const user = await fetchUser(settings, provider, token.access_token);
    const sessionCookie = await createSessionCookie(user, context.env, requestUrl);

    return redirect(authRedirect(pending.returnTo, "success"), [
      clearStateCookie,
      sessionCookie
    ]);
  } catch (error) {
    console.error(`${provider} OAuth failed`, error);
    return redirect(authRedirect(pending.returnTo, error.message || "network_error"), [
      clearStateCookie
    ]);
  }
}

function providerSettings(env, provider, requestUrl) {
  const config = PROVIDERS[provider];
  const redirectUri =
    getEnv(env, config.redirectUri) || `${requestUrl.origin}/auth/${provider}/callback`;
  const scopes = getEnv(env, config.scopes) || config.defaultScopes;
  const clientId = getEnv(env, config.clientId);
  const clientSecret = getEnv(env, config.clientSecret);

  return {
    ...config,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    configured: hasRealValue(clientId) && hasRealValue(clientSecret)
  };
}

async function fetchToken(settings, code) {
  const body = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.redirectUri
  });

  const response = await fetch(settings.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    console.error("Token exchange failed:", response.status, await response.text());
    throw new Error("token_error");
  }

  return response.json();
}

async function fetchUser(settings, provider, accessToken) {
  const response = await fetch(settings.userUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    console.error("User fetch failed:", response.status, await response.text());
    throw new Error("user_error");
  }

  const user = await response.json();
  return provider === "google" ? googlePublicUser(user) : discordPublicUser(user);
}

function discordPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name || user.username,
    discriminator: user.discriminator,
    avatar: discordAvatarUrl(user),
    email: user.email || "",
    verified: Boolean(user.verified),
    provider: "discord"
  };
}

function googlePublicUser(user) {
  return {
    id: user.sub,
    username: user.email || user.name || "Google user",
    globalName: user.name || user.email || "Google user",
    discriminator: "",
    avatar: user.picture || "",
    email: user.email || "",
    verified: Boolean(user.email_verified),
    provider: "google"
  };
}

function discordAvatarUrl(user) {
  if (!user.avatar) return "";
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

async function createSessionCookie(user, env, requestUrl) {
  const payload = encodePayload({
    user,
    expiresAt: Date.now() + SESSION_SECONDS * 1000
  });
  const value = await packSigned(payload, env);

  return serializeCookie(SESSION_COOKIE, value, {
    maxAge: SESSION_SECONDS,
    path: "/",
    secure: requestUrl.protocol === "https:"
  });
}

async function readSession(request, env) {
  const cookies = parseCookies(request);
  const payload = cookies[SESSION_COOKIE]
    ? await unpackPayload(cookies[SESSION_COOKIE], env)
    : null;

  if (!payload || payload.expiresAt < Date.now()) return null;
  return payload;
}

async function unpackPayload(signedValue, env) {
  const packed = await unpackSigned(signedValue, env);
  if (!packed) return null;

  try {
    return decodePayload(packed);
  } catch {
    return null;
  }
}

function safeReturnUrl(rawReturnTo, request, env) {
  const requestUrl = new URL(request.url);
  if (!rawReturnTo) return requestUrl.origin;

  try {
    const returnUrl = new URL(rawReturnTo, requestUrl.origin);
    if (returnUrl.protocol !== "http:" && returnUrl.protocol !== "https:") {
      return requestUrl.origin;
    }

    if (!isAllowedOrigin(returnUrl.origin, request, env)) {
      return requestUrl.origin;
    }

    return returnUrl.toString();
  } catch {
    return requestUrl.origin;
  }
}

function isAllowedOrigin(origin, request, env) {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    const requestUrl = new URL(request.url);
    const allowedOrigins = parseOriginList(
      `${getEnv(env, "FRONTEND_ORIGINS")},${getEnv(env, "ALLOWED_RETURN_ORIGINS")}`
    );

    return (
      url.origin === requestUrl.origin ||
      isLocalHostname(url.hostname) ||
      allowedOrigins.has(url.origin)
    );
  } catch {
    return false;
  }
}

function authRedirect(returnTo, status) {
  const url = new URL(returnTo);
  url.searchParams.set("auth", status);
  return url.toString();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function parseCookies(request) {
  const cookies = {};
  const header = request.headers.get("Cookie") || "";

  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) continue;
    cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  parts.push("HttpOnly");
  parts.push(`Path=${options.path || "/"}`);
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name, path = "/") {
  return serializeCookie(name, "", { maxAge: 0, path });
}

async function packSigned(value, env) {
  return `${value}.${await sign(value, env)}`;
}

async function unpackSigned(packed, env) {
  if (!packed || !packed.includes(".")) return null;
  const index = packed.lastIndexOf(".");
  const value = packed.slice(0, index);
  const signature = packed.slice(index + 1);
  const expected = await sign(value, env);
  return timingSafeEqual(signature, expected) ? value : null;
}

async function sign(value, env) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function sessionSecret(env) {
  return getEnv(env, "SESSION_SECRET") || "blopbox-dev-session-secret";
}

function encodePayload(payload) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodePayload(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

function randomToken(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

function parseOriginList(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
  );
}

function hasRealValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(
    normalized &&
      !normalized.startsWith("your_") &&
      !normalized.startsWith("replace-") &&
      !normalized.includes("your_discord")
  );
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();

  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function getEnv(env, key) {
  return String((env && env[key]) || "").trim();
}
