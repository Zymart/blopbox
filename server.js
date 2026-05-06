const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI ||
  `http://localhost:${PORT}/auth/discord/callback`;
const DISCORD_SCOPES = process.env.DISCORD_SCOPES || "identify email";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  `http://localhost:${PORT}/auth/google/callback`;
const GOOGLE_SCOPES = process.env.GOOGLE_SCOPES || "openid email profile";
const ALLOWED_RETURN_ORIGINS = parseOriginList(
  process.env.FRONTEND_ORIGINS || process.env.ALLOWED_RETURN_ORIGINS || ""
);
const SESSION_SECRET_INPUT = process.env.SESSION_SECRET || "";
const SESSION_SECRET = hasRealValue(SESSION_SECRET_INPUT)
  ? SESSION_SECRET_INPUT
  : crypto.randomBytes(32).toString("hex");

const PUBLIC_DIR = path.join(__dirname, "public");
const sessions = new Map();
const oauthStates = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
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

function isLocalHostname(hostname) {
  const normalized = String(hostname || "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function isAllowedOrigin(origin, req) {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    const requestHost = req.headers.host || "";
    return (
      isLocalHostname(url.hostname) ||
      ALLOWED_RETURN_ORIGINS.has(url.origin) ||
      url.host === requestHost
    );
  } catch {
    return false;
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, req)) return;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept");
  res.setHeader("Vary", "Origin");
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function packSigned(value) {
  return `${value}.${sign(value)}`;
}

function unpackSigned(packed) {
  if (!packed || !packed.includes(".")) return null;
  const index = packed.lastIndexOf(".");
  const value = packed.slice(0, index);
  const signature = packed.slice(index + 1);
  const expected = sign(value);

  try {
    if (
      crypto.timingSafeEqual(
        Buffer.from(signature, "base64url"),
        Buffer.from(expected, "base64url")
      )
    ) {
      return value;
    }
  } catch {
    return null;
  }

  return null;
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) continue;
    cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
  }
  return cookies;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`Path=${options.path || "/"}`);
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.secure) parts.push("Secure");

  const previous = res.getHeader("Set-Cookie");
  const cookies = Array.isArray(previous)
    ? previous.concat(parts.join("; "))
    : previous
      ? [previous, parts.join("; ")]
      : [parts.join("; ")];
  res.setHeader("Set-Cookie", cookies);
}

function clearCookie(res, name, path = "/") {
  setCookie(res, name, "", { maxAge: 0, path });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function safeReturnUrl(rawReturnTo, req) {
  if (!rawReturnTo) return "/";

  try {
    const fallbackBase = `http://${req.headers.host || `localhost:${PORT}`}`;
    const url = new URL(rawReturnTo, fallbackBase);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "/";
    if (isLocalHostname(url.hostname) && url.origin !== `http://localhost:${PORT}`) {
      return `http://localhost:${PORT}/`;
    }
    if (!isAllowedOrigin(url.origin, req)) return "/";
    return url.toString();
  } catch {
    return "/";
  }
}

function authRedirect(returnTo, status) {
  try {
    const url = new URL(returnTo, `http://localhost:${PORT}`);
    url.searchParams.set("auth", status);
    return url.toString();
  } catch {
    return `/?auth=${encodeURIComponent(status)}`;
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function createSession(user) {
  const id = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;
  sessions.set(id, { user, expiresAt });
  return id;
}

function readSession(req) {
  const cookies = parseCookies(req);
  const sessionId = unpackSigned(cookies.market_session);
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return { id: sessionId, ...session };
}

function avatarUrl(user) {
  if (!user.avatar) return "";
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name || user.username,
    discriminator: user.discriminator,
    avatar: avatarUrl(user),
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

function discordConfigured() {
  return hasRealValue(DISCORD_CLIENT_ID) && hasRealValue(DISCORD_CLIENT_SECRET);
}

function googleConfigured() {
  return hasRealValue(GOOGLE_CLIENT_ID) && hasRealValue(GOOGLE_CLIENT_SECRET);
}

async function handleDiscordStart(req, res, url) {
  const returnTo = safeReturnUrl(url.searchParams.get("returnTo"), req);

  if (!discordConfigured()) {
    return redirect(res, authRedirect(returnTo, "discord_not_configured"));
  }

  const state = crypto.randomBytes(24).toString("base64url");
  oauthStates.set(state, {
    provider: "discord",
    returnTo,
    expiresAt: Date.now() + 1000 * 60 * 10
  });
  setCookie(res, "discord_oauth_state", packSigned(state), {
    maxAge: 60 * 10,
    path: "/auth/discord"
  });

  const authUrl = new URL("https://discord.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", DISCORD_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", DISCORD_SCOPES);
  authUrl.searchParams.set("state", state);
  redirect(res, authUrl.toString());
}

async function handleDiscordCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const savedState = unpackSigned(parseCookies(req).discord_oauth_state);
  const pending = savedState ? oauthStates.get(savedState) : null;
  if (savedState) oauthStates.delete(savedState);
  clearCookie(res, "discord_oauth_state", "/auth/discord");

  if (
    !code ||
    !state ||
    !savedState ||
    state !== savedState ||
    !pending ||
    pending.provider !== "discord" ||
    pending.expiresAt < Date.now()
  ) {
    return redirect(res, authRedirect(pending ? pending.returnTo : "/", "state_error"));
  }

  try {
    const tokenBody = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI
    });

    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Discord token exchange failed:", tokenResponse.status, errorText);
      return redirect(res, authRedirect(pending.returnTo, "token_error"));
    }

    const token = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      console.error("Discord user fetch failed:", userResponse.status, errorText);
      return redirect(res, authRedirect(pending.returnTo, "user_error"));
    }

    const user = publicUser(await userResponse.json());
    const sessionId = createSession(user);
    setCookie(res, "market_session", packSigned(sessionId), {
      maxAge: 60 * 60 * 24 * 7,
      path: "/"
    });
    redirect(res, authRedirect(pending.returnTo, "success"));
  } catch (error) {
    console.error("Discord OAuth callback failed:", error);
    redirect(res, authRedirect(pending.returnTo, "network_error"));
  }
}

async function handleGoogleStart(req, res, url) {
  const returnTo = safeReturnUrl(url.searchParams.get("returnTo"), req);

  if (!googleConfigured()) {
    return redirect(res, authRedirect(returnTo, "google_not_configured"));
  }

  const state = crypto.randomBytes(24).toString("base64url");
  oauthStates.set(state, {
    provider: "google",
    returnTo,
    expiresAt: Date.now() + 1000 * 60 * 10
  });
  setCookie(res, "google_oauth_state", packSigned(state), {
    maxAge: 60 * 10,
    path: "/auth/google"
  });

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");
  redirect(res, authUrl.toString());
}

async function handleGoogleCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const savedState = unpackSigned(parseCookies(req).google_oauth_state);
  const pending = savedState ? oauthStates.get(savedState) : null;
  if (savedState) oauthStates.delete(savedState);
  clearCookie(res, "google_oauth_state", "/auth/google");

  if (
    !code ||
    !state ||
    !savedState ||
    state !== savedState ||
    !pending ||
    pending.provider !== "google" ||
    pending.expiresAt < Date.now()
  ) {
    return redirect(res, authRedirect(pending ? pending.returnTo : "/", "state_error"));
  }

  try {
    const tokenBody = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: GOOGLE_REDIRECT_URI
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Google token exchange failed:", tokenResponse.status, errorText);
      return redirect(res, authRedirect(pending.returnTo, "token_error"));
    }

    const token = await tokenResponse.json();
    const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      console.error("Google user fetch failed:", userResponse.status, errorText);
      return redirect(res, authRedirect(pending.returnTo, "user_error"));
    }

    const user = googlePublicUser(await userResponse.json());
    const sessionId = createSession(user);
    setCookie(res, "market_session", packSigned(sessionId), {
      maxAge: 60 * 60 * 24 * 7,
      path: "/"
    });
    redirect(res, authRedirect(pending.returnTo, "success"));
  } catch (error) {
    console.error("Google OAuth callback failed:", error);
    redirect(res, authRedirect(pending.returnTo, "network_error"));
  }
}

function handleLogout(req, res, url) {
  const session = readSession(req);
  if (session) sessions.delete(session.id);
  clearCookie(res, "market_session");
  redirect(res, safeReturnUrl(url.searchParams.get("returnTo"), req));
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requested.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await fsp.readFile(requested);
    const ext = path.extname(requested).toLowerCase();
    const noStore = [".html", ".css", ".js"].includes(ext);
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Cache-Control": noStore ? "no-store" : "public, max-age=3600"
    });
    res.end(file);
  } catch {
    const fallback = await fsp.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(404, { "Content-Type": contentTypes[".html"] });
    res.end(fallback);
  }
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const session = readSession(req);
    return json(res, 200, {
      authenticated: Boolean(session),
      user: session ? session.user : null
    });
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      discordConfigured: discordConfigured(),
      googleConfigured: googleConfigured(),
      authRequired: true,
      providers: {
        discord: {
          configured: discordConfigured(),
          scopes: DISCORD_SCOPES,
          redirectUri: DISCORD_REDIRECT_URI
        },
        google: {
          configured: googleConfigured(),
          scopes: GOOGLE_SCOPES,
          redirectUri: GOOGLE_REDIRECT_URI
        }
      },
      scopes: DISCORD_SCOPES,
      redirectUri: DISCORD_REDIRECT_URI
    });
  }

  if (req.method === "GET" && url.pathname === "/auth/discord") {
    return handleDiscordStart(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/auth/discord/callback") {
    return handleDiscordCallback(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/auth/google") {
    return handleGoogleStart(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/auth/google/callback") {
    return handleGoogleCallback(req, res, url);
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    return handleLogout(req, res, url);
  }

  if (req.method === "GET") {
    return serveStatic(req, res, url);
  }

  json(res, 405, { error: "Method not allowed" });
}

const server = http.createServer((req, res) => {
  router(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { error: "Internal server error" });
  });
});

server.listen(PORT, () => {
  console.log(`Blopbox running at http://localhost:${PORT}`);
  if (!discordConfigured()) {
    console.log("Discord login is waiting for DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env");
  }
  if (!googleConfigured()) {
    console.log("Google login is waiting for GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
  }
});
