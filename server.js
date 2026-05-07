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
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const ALLOWED_RETURN_ORIGINS = parseOriginList(
  process.env.FRONTEND_ORIGINS || process.env.ALLOWED_RETURN_ORIGINS || ""
);
const SESSION_SECRET_INPUT = process.env.SESSION_SECRET || "";
const SESSION_SECRET = hasRealValue(SESSION_SECRET_INPUT)
  ? SESSION_SECRET_INPUT
  : crypto.randomBytes(32).toString("hex");

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const MAX_PRODUCTS = 250;
const MAX_PRODUCTS_PER_USER = 3;
const MAX_COMMENTS_PER_PRODUCT = 120;
const MAX_IMAGE_LENGTH = 3_000_000;
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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

function clientCountry(req) {
  return cleanCountryCode(
    req.headers["cf-ipcountry"] ||
      req.headers["x-vercel-ip-country"] ||
      req.headers["x-country-code"] ||
      req.headers["cloudfront-viewer-country"] ||
      ""
  );
}

function cleanCountryCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
}

function cleanCurrencyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

async function handleExchangeRate(req, res, url) {
  const session = readSession(req);
  const countryCode = cleanCountryCode(url.searchParams.get("country") || session?.user?.countryCode || clientCountry(req));
  const currency = cleanCurrencyCode(url.searchParams.get("currency")) || "USD";

  if (currency === "USD") {
    return json(res, 200, {
      base: "USD",
      currency,
      countryCode,
      rate: 1
    });
  }

  try {
    const rate = await fetchExchangeRate("USD", currency);
    return json(res, 200, {
      base: "USD",
      currency,
      countryCode,
      rate: rate.rate,
      date: rate.date
    });
  } catch (error) {
    console.error("Exchange rate fetch failed:", error);
    return json(res, 200, {
      base: "USD",
      currency: "USD",
      countryCode,
      rate: 1,
      error: "exchange_rate_unavailable"
    });
  }
}

async function fetchExchangeRate(base, currency) {
  const url = new URL("https://api.frankfurter.dev/v2/rates");
  url.searchParams.set("base", base);
  url.searchParams.set("quotes", currency);

  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Rate API returned ${response.status}`);

  const body = await response.json();
  const row = Array.isArray(body) ? body[0] : null;
  const rate = Number(row && row.rate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`No ${currency} rate found`);

  return {
    rate,
    date: row.date || ""
  };
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

async function readProducts() {
  try {
    const saved = await fsp.readFile(PRODUCTS_FILE, "utf8");
    const products = JSON.parse(saved);
    return Array.isArray(products) ? products.map(normalizeStoredProduct).filter(Boolean) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeProducts(products) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(PRODUCTS_FILE, `${JSON.stringify(products, null, 2)}\n`);
}

function normalizeStoredProduct(product) {
  if (!product || typeof product !== "object") return null;
  const id = cleanId(product.id);
  const title = cleanText(product.title, 60);
  const seller = cleanText(product.seller, 32);
  const price = Math.max(1, Math.min(9999, Math.round(Number(product.price) || 0)));
  if (!id || !title || !seller || !price) return null;

  return {
    id,
    title,
    seller,
    tags: normalizeProductTags(product.tags),
    price,
    details: cleanText(product.details, 140),
    image: cleanImage(product.image),
    tag: cleanText(product.tag, 24) || "Post",
    createdAt: normalizeTimestamp(product.createdAt),
    ownerId: cleanText(product.ownerId, 120),
    ownerName: cleanText(product.ownerName, 80),
    comments: normalizeComments(product.comments)
  };
}

function sanitizeProduct(input, user) {
  return normalizeStoredProduct({
    ...input,
    id: cleanId(input && input.id) || `product-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
    tag: "Post",
    ownerId: userKey(user),
    ownerName: user.globalName || user.username || "Seller",
    comments: []
  });
}

function cleanId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : "";
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeProductTags(tags) {
  const pieces = Array.isArray(tags) ? tags : String(tags || "").split(/[\s,]+/);
  const normalized = pieces
    .map((tag) => cleanText(tag, 24).toLowerCase())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .map((tag) => tag.replace(/[^#a-z0-9_-]/g, ""))
    .filter((tag) => tag.length > 1);

  return [...new Set(normalized)].slice(0, 6);
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  const now = Date.now();
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 60_000) return now;
  return timestamp;
}

function cleanImage(value) {
  const image = String(value || "").trim();
  if (image.length > MAX_IMAGE_LENGTH) return "";
  if (
    image.startsWith("data:image/") ||
    image.startsWith("http://") ||
    image.startsWith("https://")
  ) {
    return image;
  }
  return "";
}

function userKey(user) {
  return `${user.provider || "account"}:${user.id || user.email || user.username || "unknown"}`;
}

function canManageProduct(product, user) {
  return Boolean(product.ownerId) && product.ownerId === userKey(user);
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return [];

  return comments
    .map((comment) => {
      if (!comment || typeof comment !== "object") return null;
      const id = cleanId(comment.id);
      const text = cleanText(comment.text, 220);
      const authorId = cleanText(comment.authorId, 120);
      const authorName = cleanText(comment.authorName, 80);
      if (!id || !text || !authorId || !authorName) return null;

      return {
        id,
        text,
        authorId,
        authorName,
        authorAvatar: cleanImage(comment.authorAvatar),
        createdAt: normalizeTimestamp(comment.createdAt),
        replies: normalizeReplies(comment.replies)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_COMMENTS_PER_PRODUCT);
}

function normalizeReplies(replies) {
  if (!Array.isArray(replies)) return [];

  return replies
    .map((reply) => {
      if (!reply || typeof reply !== "object") return null;
      const id = cleanId(reply.id);
      const text = cleanText(reply.text, 220);
      const authorId = cleanText(reply.authorId, 120);
      const authorName = cleanText(reply.authorName, 80);
      if (!id || !text || !authorId || !authorName) return null;

      return {
        id,
        text,
        authorId,
        authorName,
        authorAvatar: cleanImage(reply.authorAvatar),
        createdAt: normalizeTimestamp(reply.createdAt)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, 40);
}

function sanitizeComment(input, user) {
  const text = cleanText(input && input.text, 220);
  if (!text) return null;

  return {
    id: `comment-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
    text,
    authorId: userKey(user),
    authorName: user.globalName || user.username || "User",
    authorAvatar: cleanImage(user.avatar),
    replies: [],
    createdAt: Date.now()
  };
}

function sanitizeReply(input, user) {
  const text = cleanText(input && input.text, 220);
  if (!text) return null;

  return {
    id: `reply-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
    text,
    authorId: userKey(user),
    authorName: user.globalName || user.username || "User",
    authorAvatar: cleanImage(user.avatar),
    createdAt: Date.now()
  };
}

function addReplyToComments(comments, parentCommentId, reply) {
  let found = false;
  const next = comments.map((comment) => {
    if (comment.id !== parentCommentId) return comment;
    found = true;
    return {
      ...comment,
      replies: [...(comment.replies || []), reply].slice(-40)
    };
  });

  return found ? next : null;
}

function userProductCount(products, user, ignoredProductId = "") {
  const ownerId = userKey(user);
  return products.filter((product) => {
    return product.ownerId === ownerId && product.id !== ignoredProductId;
  }).length;
}

async function handleProductComment(req, res) {
  const session = readSession(req);
  if (!session) {
    return json(res, 401, { error: "Sign in first." });
  }

  try {
    const body = await readJsonBody(req);
    const productId = cleanId(body.productId);
    const parentCommentId = cleanId(body.parentCommentId);
    const comment = parentCommentId ? null : sanitizeComment(body, session.user);
    const reply = parentCommentId ? sanitizeReply(body, session.user) : null;
    if (!productId || (!comment && !reply)) {
      return json(res, 400, { error: "Add a comment first." });
    }

    const products = await readProducts();
    const index = products.findIndex((product) => product.id === productId);
    if (index === -1) return json(res, 404, { error: "Product was not found." });

    const comments = products[index].comments || [];
    const nextComments = parentCommentId
      ? addReplyToComments(comments, parentCommentId, reply)
      : [comment, ...comments].slice(0, MAX_COMMENTS_PER_PRODUCT);
    if (!nextComments) return json(res, 404, { error: "Comment was not found." });

    const product = {
      ...products[index],
      comments: nextComments
    };
    const next = products.slice();
    next[index] = product;
    await writeProducts(next);
    return json(res, 201, { product, comment });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.message || "Could not save comment." });
  }
}

async function handleCheckout(req, res, url) {
  if (!stripeConfigured()) {
    return json(res, 503, { error: "Stripe payments need STRIPE_SECRET_KEY in the server environment." });
  }

  const session = readSession(req);
  if (!session) return json(res, 401, { error: "Sign in first." });

  try {
    const body = await readJsonBody(req, 64 * 1024);
    const productId = cleanId(body.productId);
    if (!productId) return json(res, 400, { error: "Product id is required." });

    const products = await readProducts();
    const product = products.find((item) => item.id === productId);
    if (!product) return json(res, 404, { error: "Product was not found." });
    if (canManageProduct(product, session.user)) {
      return json(res, 403, { error: "You cannot buy your own product." });
    }

    const countryCode = cleanCountryCode(body.countryCode || session.user.countryCode || clientCountry(req));
    const requestedCurrency = cleanCurrencyCode(body.currency);
    const currency = requestedCurrency || currencyForCountry(countryCode);
    const exchange = currency === "USD"
      ? { rate: 1, currency: "USD" }
      : await fetchExchangeRate("USD", currency);
    const unitAmount = stripeUnitAmount(product.price, exchange.rate, currency);
    const returnTo = safeReturnUrl(body.returnTo || req.headers.referer || "/", req);
    const checkout = await createStripeCheckoutSession({
      product,
      user: session.user,
      currency,
      unitAmount,
      returnTo,
      requestUrl: url
    });

    return json(res, 200, {
      id: checkout.id,
      url: checkout.url
    });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "Could not start Stripe checkout."
    });
  }
}

async function createStripeCheckoutSession({ product, user, currency, unitAmount, returnTo, requestUrl }) {
  const successUrl = checkoutReturnUrl(returnTo, "success");
  const cancelUrl = checkoutReturnUrl(returnTo, "cancel");
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("client_reference_id", product.id);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", currency.toLowerCase());
  params.set("line_items[0][price_data][unit_amount]", String(unitAmount));
  params.set("line_items[0][price_data][product_data][name]", product.title);
  params.set("line_items[0][price_data][product_data][description]", product.details || `Seller: ${product.seller}`);
  params.set("line_items[0][price_data][product_data][metadata][product_id]", product.id);
  params.set("metadata[product_id]", product.id);
  params.set("metadata[seller_id]", product.ownerId || "");
  params.set("metadata[buyer_id]", userKey(user));
  params.set("payment_intent_data[metadata][product_id]", product.id);
  params.set("payment_intent_data[metadata][seller_id]", product.ownerId || "");
  params.set("payment_intent_data[metadata][buyer_id]", userKey(user));
  if (user.email) params.set("customer_email", user.email);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error?.message || `Stripe returned ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  if (!body.url) throw new Error("Stripe did not return a checkout link.");
  return body;
}

function checkoutReturnUrl(returnTo, status) {
  const url = new URL(returnTo);
  url.searchParams.set("checkout", status);
  return url.toString();
}

function stripeUnitAmount(price, rate, currency) {
  const zeroDecimalCurrencies = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const factor = zeroDecimalCurrencies.has(currency) ? 1 : 100;
  return Math.max(1, Math.round(Number(price || 0) * Number(rate || 1) * factor));
}

function currencyForCountry(countryCode) {
  const currencies = {
    AE: "AED", AR: "ARS", AT: "EUR", AU: "AUD", BD: "BDT", BE: "EUR", BG: "BGN",
    BH: "BHD", BN: "BND", BR: "BRL", CA: "CAD", CH: "CHF", CL: "CLP", CN: "CNY",
    CO: "COP", CZ: "CZK", DE: "EUR", DK: "DKK", EG: "EGP", ES: "EUR", FI: "EUR",
    FR: "EUR", GB: "GBP", GR: "EUR", HK: "HKD", HR: "EUR", HU: "HUF", ID: "IDR",
    IE: "EUR", IL: "ILS", IN: "INR", IT: "EUR", JP: "JPY", KR: "KRW", KW: "KWD",
    LK: "LKR", MX: "MXN", MY: "MYR", NG: "NGN", NL: "EUR", NO: "NOK", NZ: "NZD",
    PH: "PHP", PK: "PKR", PL: "PLN", PT: "EUR", QA: "QAR", RO: "RON", SA: "SAR",
    SE: "SEK", SG: "SGD", TH: "THB", TR: "TRY", TW: "TWD", US: "USD", VN: "VND",
    ZA: "ZAR"
  };
  return currencies[cleanCountryCode(countryCode)] || "USD";
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) tooLarge = true;
    });

    req.on("end", () => {
      if (tooLarge) {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        reject(error);
        return;
      }

      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch {
        const error = new Error("Invalid JSON body.");
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

async function handleProducts(req, res, url) {
  if (req.method === "GET") {
    const products = await readProducts();
    return json(res, 200, { products, storageConfigured: true });
  }

  const session = readSession(req);
  if (!session) {
    return json(res, 401, { error: "Sign in first." });
  }

  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const product = sanitizeProduct(body, session.user);
      if (!product || product.tags.length === 0) {
        return json(res, 400, { error: "Fill in the required product fields." });
      }

      const products = await readProducts();
      if (userProductCount(products, session.user, product.id) >= MAX_PRODUCTS_PER_USER) {
        return json(res, 403, { error: "You can only post up to 3 products." });
      }

      const next = [product, ...products.filter((item) => item.id !== product.id)]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_PRODUCTS);
      await writeProducts(next);
      return json(res, 201, { product });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Could not save product." });
    }
  }

  if (req.method === "DELETE") {
    const productId = cleanId(url.searchParams.get("id"));
    if (!productId) return json(res, 400, { error: "Product id is required." });

    const products = await readProducts();
    const product = products.find((item) => item.id === productId);
    if (!product) return json(res, 404, { error: "Product was not found." });
    if (!canManageProduct(product, session.user)) {
      return json(res, 403, { error: "You can only remove your own products." });
    }

    await writeProducts(products.filter((item) => item.id !== productId));
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: "Method not allowed" });
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

function stripeConfigured() {
  return (
    hasRealValue(STRIPE_SECRET_KEY) &&
    STRIPE_SECRET_KEY.startsWith("sk_") &&
    !STRIPE_SECRET_KEY.includes("your_stripe")
  );
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
    user.countryCode = clientCountry(req);
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
    user.countryCode = clientCountry(req);
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
      stripeConfigured: stripeConfigured(),
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

  if (req.method === "GET" && url.pathname === "/api/exchange-rate") {
    return handleExchangeRate(req, res, url);
  }

  if (url.pathname === "/api/products") {
    return handleProducts(req, res, url);
  }

  if (req.method === "POST" && url.pathname === "/api/products/comment") {
    return handleProductComment(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/checkout") {
    return handleCheckout(req, res, url);
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
