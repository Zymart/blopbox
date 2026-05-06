import { readSession } from "./oauth.js";

const STORAGE_KEY = "products";
const MAX_PRODUCTS = 250;
const MAX_IMAGE_LENGTH = 3_000_000;

export async function handleProducts(context) {
  if (context.request.method === "GET") {
    const { products, configured } = await readProducts(context.env);
    return json({ products, storageConfigured: configured });
  }

  const session = await readSession(context.request, context.env);
  if (!session) return json({ error: "Sign in first." }, 401);

  if (context.request.method === "POST") {
    const store = productStore(context.env);
    if (!store) {
      return json({ error: "Cloudflare product storage is not connected yet." }, 503);
    }

    try {
      const body = await context.request.json();
      const product = sanitizeProduct(body, session.user);
      if (!product || product.tags.length === 0) {
        return json({ error: "Fill in the required product fields." }, 400);
      }

      const { products } = await readProducts(context.env);
      const next = [product, ...products.filter((item) => item.id !== product.id)]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_PRODUCTS);
      await store.put(STORAGE_KEY, JSON.stringify(next));
      return json({ product }, 201);
    } catch (error) {
      return json({ error: error.message || "Could not save product." }, 400);
    }
  }

  if (context.request.method === "DELETE") {
    const store = productStore(context.env);
    if (!store) {
      return json({ error: "Cloudflare product storage is not connected yet." }, 503);
    }

    const url = new URL(context.request.url);
    const productId = cleanId(url.searchParams.get("id"));
    if (!productId) return json({ error: "Product id is required." }, 400);

    const { products } = await readProducts(context.env);
    const product = products.find((item) => item.id === productId);
    if (!product) return json({ error: "Product was not found." }, 404);
    if (!canManageProduct(product, session.user)) {
      return json({ error: "You can only remove your own products." }, 403);
    }

    await store.put(STORAGE_KEY, JSON.stringify(products.filter((item) => item.id !== productId)));
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function readProducts(env) {
  const store = productStore(env);
  if (!store) return { products: [], configured: false };

  const saved = await store.get(STORAGE_KEY, "json");
  const products = Array.isArray(saved) ? saved.map(normalizeStoredProduct).filter(Boolean) : [];
  return { products, configured: true };
}

function productStore(env) {
  return env.PRODUCTS_KV || env.BLOPBOX_PRODUCTS || env.PRODUCT_STORE || null;
}

function sanitizeProduct(input, user) {
  return normalizeStoredProduct({
    ...input,
    id: cleanId(input && input.id) || `product-${Date.now()}-${randomId()}`,
    tag: "Post",
    ownerId: userKey(user),
    ownerName: user.globalName || user.username || "Seller"
  });
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
    ownerName: cleanText(product.ownerName, 80)
  };
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
  return !product.ownerId || product.ownerId === userKey(user);
}

function randomId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
