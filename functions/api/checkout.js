import { readSession } from "../_shared/oauth.js";

const STORAGE_KEY = "products";

export async function onRequestPost(context) {
  if (!stripeConfigured(context.env)) {
    return json({ error: "Stripe payments need STRIPE_SECRET_KEY in the server environment." }, 503);
  }

  const session = await readSession(context.request, context.env);
  if (!session) return json({ error: "Sign in first." }, 401);

  try {
    const body = await context.request.json();
    const productId = cleanId(body.productId);
    if (!productId) return json({ error: "Product id is required." }, 400);

    const products = await readProducts(context.env);
    const product = products.find((item) => item.id === productId);
    if (!product) return json({ error: "Product was not found." }, 404);
    if (canManageProduct(product, session.user)) {
      return json({ error: "You cannot buy your own product." }, 403);
    }

    const countryCode = cleanCountryCode(body.countryCode || session.user.countryCode || clientCountry(context.request));
    const requestedCurrency = cleanCurrencyCode(body.currency);
    const currency = requestedCurrency || currencyForCountry(countryCode);
    const exchange = currency === "USD"
      ? { rate: 1, currency: "USD" }
      : await fetchExchangeRate("USD", currency);
    const returnTo = safeReturnUrl(body.returnTo || context.request.headers.get("Referer") || "/", context.request, context.env);
    const checkout = await createStripeCheckoutSession({
      env: context.env,
      product,
      user: session.user,
      currency,
      unitAmount: stripeUnitAmount(product.price, exchange.rate, currency),
      returnTo
    });

    return json({
      id: checkout.id,
      url: checkout.url
    });
  } catch (error) {
    return json({ error: error.message || "Could not start Stripe checkout." }, error.statusCode || 500);
  }
}

async function readProducts(env) {
  const store = env.PRODUCTS_KV || env.BLOPBOX_PRODUCTS || env.PRODUCT_STORE || null;
  if (!store) return [];

  const saved = await store.get(STORAGE_KEY, "json");
  return Array.isArray(saved) ? saved.map(normalizeStoredProduct).filter(Boolean) : [];
}

async function createStripeCheckoutSession({ env, product, user, currency, unitAmount, returnTo }) {
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", checkoutReturnUrl(returnTo, "success"));
  params.set("cancel_url", checkoutReturnUrl(returnTo, "cancel"));
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
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
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

async function fetchExchangeRate(base, currency) {
  const url = new URL("https://api.frankfurter.dev/v2/rates");
  url.searchParams.set("base", base);
  url.searchParams.set("quotes", currency);

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Rate API returned ${response.status}`);

  const body = await response.json();
  const row = Array.isArray(body) ? body[0] : null;
  const rate = Number(row && row.rate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`No ${currency} rate found`);
  return { rate, date: row.date || "" };
}

function checkoutReturnUrl(returnTo, status) {
  const url = new URL(returnTo);
  url.searchParams.set("checkout", status);
  return url.toString();
}

function safeReturnUrl(rawReturnTo, request, env) {
  const requestUrl = new URL(request.url);
  try {
    const returnUrl = new URL(rawReturnTo || requestUrl.origin, requestUrl.origin);
    if (returnUrl.protocol !== "http:" && returnUrl.protocol !== "https:") return requestUrl.origin;
    if (!isAllowedOrigin(returnUrl.origin, request, env)) return requestUrl.origin;
    return returnUrl.toString();
  } catch {
    return requestUrl.origin;
  }
}

function isAllowedOrigin(origin, request, env) {
  try {
    const url = new URL(origin);
    const requestUrl = new URL(request.url);
    const allowedOrigins = new Set(
      `${env.FRONTEND_ORIGINS || ""},${env.ALLOWED_RETURN_ORIGINS || ""}`
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => new URL(item).origin)
    );
    return url.origin === requestUrl.origin || isLocalHostname(url.hostname) || allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(hostname || "").toLowerCase());
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
    price,
    details: cleanText(product.details, 140),
    ownerId: cleanText(product.ownerId, 120)
  };
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

function clientCountry(request) {
  const headers = request.headers;
  return cleanCountryCode(
    request.cf?.country ||
      headers.get("CF-IPCountry") ||
      headers.get("X-Vercel-IP-Country") ||
      headers.get("X-Country-Code") ||
      headers.get("CloudFront-Viewer-Country") ||
      ""
  );
}

function userKey(user) {
  return `${user.provider || "account"}:${user.id || user.email || user.username || "unknown"}`;
}

function canManageProduct(product, user) {
  return Boolean(product.ownerId) && product.ownerId === userKey(user);
}

function cleanId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : "";
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanCountryCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
}

function cleanCurrencyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

function stripeConfigured(env) {
  const key = String(env.STRIPE_SECRET_KEY || "");
  return key.startsWith("sk_") && !key.includes("your_stripe");
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
