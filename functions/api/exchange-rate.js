import { readSession } from "../_shared/oauth.js";

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const session = await readSession(context.request, context.env);
  const countryCode = cleanCountryCode(
    requestUrl.searchParams.get("country") ||
      session?.user?.countryCode ||
      clientCountry(context.request)
  );
  const currency = cleanCurrencyCode(requestUrl.searchParams.get("currency")) || "USD";

  if (currency === "USD") {
    return json({
      base: "USD",
      currency,
      countryCode,
      rate: 1
    });
  }

  try {
    const rate = await fetchExchangeRate("USD", currency);
    return json({
      base: "USD",
      currency,
      countryCode,
      rate: rate.rate,
      date: rate.date
    });
  } catch (error) {
    console.error("Exchange rate fetch failed:", error);
    return json({
      base: "USD",
      currency: "USD",
      countryCode,
      rate: 1,
      error: "exchange_rate_unavailable"
    });
  }
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=1800"
    }
  });
}
