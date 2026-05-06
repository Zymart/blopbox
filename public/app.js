const PLACEHOLDER_IMAGE =
  "https://images.unsplash.com/photo-1603481546579-65d935ba9cdd?auto=format&fit=crop&w=900&q=80";
const AUTH_SERVER_PORT = "3000";
const API_ORIGIN = resolveApiOrigin();

const state = {
  authConfig: null,
  authMessage: "",
  mode: "market",
  query: "",
  sort: "newest",
  listings: readListings(),
  user: null
};

const elements = {
  accountControls: document.querySelector("#accountControls"),
  authStatus: document.querySelector("#authStatus"),
  browseHeroButton: document.querySelector("#browseHeroButton"),
  closePostButton: document.querySelector("#closePostButton"),
  discordLoginButton: document.querySelector("#discordLoginButton"),
  googleLoginButton: document.querySelector("#googleLoginButton"),
  itemDetails: document.querySelector("#itemDetails"),
  itemImageFile: document.querySelector("#itemImageFile"),
  itemPrice: document.querySelector("#itemPrice"),
  itemSeller: document.querySelector("#itemSeller"),
  itemTags: document.querySelector("#itemTags"),
  itemTitle: document.querySelector("#itemTitle"),
  loginGate: document.querySelector("#loginGate"),
  listingCount: document.querySelector("#listingCount"),
  listingForm: document.querySelector("#listingForm"),
  logoutButton: document.querySelector("#logoutButton"),
  marketTitle: document.querySelector("#marketTitle"),
  navTabs: document.querySelectorAll(".nav-tab"),
  openPostButton: document.querySelector("#openPostButton"),
  postOverlay: document.querySelector("#postOverlay"),
  productGrid: document.querySelector("#productGrid"),
  searchInput: document.querySelector("#searchInput"),
  sellHeroButton: document.querySelector("#sellHeroButton"),
  sortSelect: document.querySelector("#sortSelect"),
  toast: document.querySelector("#toast"),
  uploadButton: document.querySelector("#uploadButton"),
  uploadFileName: document.querySelector("#uploadFileName"),
  userAvatar: document.querySelector("#userAvatar"),
  userName: document.querySelector("#userName"),
  userProvider: document.querySelector("#userProvider")
};

init();

async function init() {
  bindControls();
  await hydrateAuth();
  renderAuth();
  renderListings();

  if (state.user && state.authMessage) toast(state.authMessage);
}

function bindControls() {
  elements.openPostButton.addEventListener("click", openPostForm);
  elements.sellHeroButton.addEventListener("click", openPostForm);
  elements.browseHeroButton.addEventListener("click", () => {
    activateMode("drops");
    document.querySelector("#listings").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  elements.closePostButton.addEventListener("click", closePostForm);
  elements.logoutButton.addEventListener("click", logout);

  elements.postOverlay.addEventListener("click", (event) => {
    if (event.target === elements.postOverlay) closePostForm();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.postOverlay.hidden) closePostForm();
  });

  elements.listingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await addListing();
  });

  elements.itemImageFile.addEventListener("change", () => {
    const file = elements.itemImageFile.files && elements.itemImageFile.files[0];
    elements.uploadFileName.textContent = file
      ? file.name
      : "Choose from phone gallery, camera roll, or laptop files.";
  });

  elements.uploadButton.addEventListener("click", () => {
    elements.itemImageFile.click();
  });

  elements.uploadButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.itemImageFile.click();
    }
  });

  elements.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderListings();
  });

  elements.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderListings();
  });

  elements.navTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activateMode(tab.dataset.mode || "market");
      renderListings();
    });
  });
}

function activateMode(mode) {
  state.mode = mode;
  elements.navTabs.forEach((item) => {
    item.classList.toggle("active", (item.dataset.mode || "market") === mode);
  });
}

async function hydrateAuth() {
  const authStatus = readAuthStatus();

  try {
    const [config, session] = await Promise.all([fetchJson("/api/config"), fetchJson("/api/me")]);
    state.authConfig = config;
    state.user = session.authenticated ? session.user : null;

    if (authStatus === "success" && !state.user && shouldFinishLoginOnApiOrigin()) {
      window.location.replace(authStatusUrl("success", API_ORIGIN));
      return;
    }

    state.authMessage =
      authStatus === "success" && !state.user
        ? "Login finished, but no session was found. Try again."
        : authMessage(authStatus);

    if (!state.user && !state.authMessage && !hasConfiguredProvider()) {
      state.authMessage =
        "Add Discord or Google OAuth keys in .env locally, or in Cloudflare Pages environment variables.";
    }
  } catch {
    state.authConfig = null;
    state.user = null;
    state.authMessage = `Login server is not reachable at ${API_ORIGIN}. Run npm start locally or redeploy Cloudflare Pages with Functions.`;
  }

  clearAuthStatus();
}

async function fetchJson(path) {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json();
}

function renderAuth() {
  const authenticated = Boolean(state.user);
  document.body.classList.remove("auth-loading");
  document.body.classList.toggle("is-authenticated", authenticated);
  document.body.classList.toggle("is-locked", !authenticated);
  elements.loginGate.hidden = authenticated;
  elements.accountControls.hidden = !authenticated;

  renderProviderButton("discord", elements.discordLoginButton);
  renderProviderButton("google", elements.googleLoginButton);

  if (authenticated) {
    renderAccount();
    elements.authStatus.textContent = "";
    return;
  }

  elements.authStatus.textContent = state.authMessage || "Sign in to continue.";
}

function renderProviderButton(provider, button) {
  const configured = providerConfigured(provider);
  button.href = authStartUrl(provider);
  button.classList.toggle("needs-config", !configured);
  button.title = configured ? "" : `${providerLabel(provider)} needs OAuth keys in your auth environment.`;
}

function renderAccount() {
  const name = state.user.globalName || state.user.username || "Signed in";
  elements.userName.textContent = name;
  elements.userProvider.textContent = state.user.provider || "account";
  renderUserAvatar(name);
}

function renderUserAvatar(name) {
  const fallback = initialAvatar(name, state.user.provider || "account");
  const avatar = String(state.user.avatar || "").trim();
  elements.userAvatar.alt = `${name} profile picture`;
  elements.userAvatar.hidden = false;
  elements.userAvatar.onerror = () => {
    elements.userAvatar.onerror = null;
    elements.userAvatar.src = fallback;
  };
  elements.userAvatar.src = avatar || fallback;
}

function initialAvatar(name, provider) {
  const initial = (String(name || "B").trim().charAt(0) || "B").toUpperCase();
  const label = providerLabel(provider || "account");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="g" x1="12" x2="84" y1="14" y2="86" gradientUnits="userSpaceOnUse">
          <stop stop-color="#2f58ff"/>
          <stop offset="1" stop-color="#8d42ff"/>
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="20" fill="#070b1b"/>
      <rect x="4" y="4" width="88" height="88" rx="18" fill="url(#g)"/>
      <text x="48" y="56" text-anchor="middle" font-family="Arial, sans-serif" font-size="38" font-weight="800" fill="#fff">${escapeHtml(initial)}</text>
      <text x="48" y="75" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="rgba(255,255,255,0.72)">${escapeHtml(label)}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function providerConfigured(provider) {
  const providers = state.authConfig && state.authConfig.providers;
  if (providers && providers[provider]) return Boolean(providers[provider].configured);
  return Boolean(state.authConfig && state.authConfig[`${provider}Configured`]);
}

function hasConfiguredProvider() {
  return providerConfigured("discord") || providerConfigured("google");
}

function providerLabel(provider) {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function authStartUrl(provider) {
  const url = new URL(`/auth/${provider}`, API_ORIGIN);
  url.searchParams.set("returnTo", appReturnUrl());
  return url.toString();
}

function apiUrl(path) {
  return new URL(path, API_ORIGIN).toString();
}

function resolveApiOrigin() {
  const configured =
    document.querySelector('meta[name="auth-api-origin"]')?.content ||
    window.BLOPBOX_AUTH_ORIGIN ||
    "";
  const trimmed = String(configured).trim().replace(/\/$/, "");
  if (trimmed) return trimmed;

  if (window.location.protocol === "file:") {
    return `http://localhost:${AUTH_SERVER_PORT}`;
  }

  const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (localHostnames.has(window.location.hostname)) {
    return `http://localhost:${AUTH_SERVER_PORT}`;
  }

  return window.location.origin;
}

function cleanPageUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("auth");
  return url.toString();
}

function appReturnUrl() {
  const current = new URL(window.location.href);
  const api = new URL(API_ORIGIN);
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

  if (localHostnames.has(current.hostname) && localHostnames.has(api.hostname)) {
    const url = new URL("/", API_ORIGIN);
    return url.toString();
  }

  current.searchParams.delete("auth");
  return current.toString();
}

function shouldFinishLoginOnApiOrigin() {
  const current = new URL(window.location.href);
  const api = new URL(API_ORIGIN);
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

  return (
    current.origin !== api.origin &&
    localHostnames.has(current.hostname) &&
    localHostnames.has(api.hostname)
  );
}

function authStatusUrl(status, origin) {
  const url = new URL("/", origin);
  url.searchParams.set("auth", status);
  return url.toString();
}

function readAuthStatus() {
  return new URL(window.location.href).searchParams.get("auth") || "";
}

function clearAuthStatus() {
  if (!readAuthStatus()) return;
  window.history.replaceState({}, document.title, cleanPageUrl());
}

function authMessage(status) {
  const messages = {
    success: "You are signed in.",
    discord_not_configured: "Discord login needs OAuth keys in the server environment.",
    google_not_configured: "Google login needs OAuth keys in the server environment.",
    state_error: "Login expired. Try again.",
    token_error: "Login could not finish. Check the OAuth settings.",
    user_error: "Could not read your profile. Try again.",
    network_error: "Could not reach the login provider. Try again.",
    not_configured: "That login provider is not configured yet."
  };
  return messages[status] || "";
}

function requireAuth() {
  if (state.user) return true;
  renderAuth();
  toast("Sign in first.");
  return false;
}

async function logout() {
  const returnTo = appReturnUrl();
  const url = new URL("/auth/logout", API_ORIGIN);
  url.searchParams.set("returnTo", returnTo);

  try {
    const response = await fetch(url, {
      credentials: "include",
      method: "POST"
    });
    window.location.href = response.url || returnTo;
  } catch {
    toast("Could not log out. Try again.");
  }
}

function openPostForm() {
  if (!requireAuth()) return;

  if (!elements.itemSeller.value.trim() && state.user) {
    elements.itemSeller.value = state.user.globalName || state.user.username || "";
  }

  elements.postOverlay.hidden = false;
  elements.itemTitle.focus();
}

function closePostForm() {
  elements.postOverlay.hidden = true;
}

async function addListing() {
  if (!requireAuth()) return;

  const title = elements.itemTitle.value.trim();
  const seller = elements.itemSeller.value.trim();
  const tags = normalizeTags(elements.itemTags.value);
  const price = Number(elements.itemPrice.value);
  const details = elements.itemDetails.value.trim();

  if (!title || !seller || tags.length === 0 || !Number.isFinite(price) || price <= 0) {
    toast("Fill in the required listing fields.");
    return;
  }

  let image = PLACEHOLDER_IMAGE;
  try {
    image = await resolveListingImage();
  } catch (error) {
    toast(error.message);
    return;
  }

  const listing = {
    id: `listing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    seller,
    tags,
    price: Math.round(price),
    details,
    image,
    tag: "Post",
    createdAt: Date.now()
  };

  state.listings = [listing, ...state.listings];

  try {
    writeListings(state.listings);
  } catch {
    state.listings = state.listings.filter((item) => item.id !== listing.id);
    toast("That image is too large for local storage. Try a smaller image.");
    return;
  }

  elements.listingForm.reset();
  elements.uploadFileName.textContent = "Choose from phone gallery, camera roll, or laptop files.";
  closePostForm();
  renderListings();
  toast("Listing posted to Blopbox.");
}

async function resolveListingImage() {
  const file = elements.itemImageFile.files && elements.itemImageFile.files[0];
  if (file) return imageFileToDataUrl(file);
  return PLACEHOLDER_IMAGE;
}

function imageFileToDataUrl(file) {
  if (!file.type.startsWith("image/")) {
    return Promise.reject(new Error("Choose an image file."));
  }

  if (file.size > 12 * 1024 * 1024) {
    return Promise.reject(new Error("Choose an image under 12 MB."));
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      const maxSide = 1100;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      canvas.width = width;
      canvas.height = height;
      context.fillStyle = "#020604";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not load that image."));
    };

    image.src = objectUrl;
  });
}

function renderListings() {
  const visible = filteredListings();
  elements.listingCount.textContent = visible.length;
  if (elements.marketTitle) elements.marketTitle.textContent = viewTitle();
  elements.productGrid.innerHTML = "";

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <strong>No matching listings.</strong>
      <span>Try another search or post the first item.</span>
      <button class="primary-button" type="button">Post Listing</button>
    `;
    empty.querySelector("button").addEventListener("click", openPostForm);
    elements.productGrid.append(empty);
    return;
  }

  for (const listing of visible) {
    const card = listingCard(listing);
    card.querySelector(".delete-button").addEventListener("click", () => removeListing(listing.id));
    elements.productGrid.append(card);
  }
}

function listingCard(listing) {
  const card = document.createElement("article");
  const media = document.createElement("div");
  const image = document.createElement("img");
  const tag = document.createElement("span");
  const body = document.createElement("div");
  const titleRow = document.createElement("div");
  const title = document.createElement("h3");
  const price = document.createElement("strong");
  const meta = document.createElement("div");
  const tags = document.createElement("span");
  const age = document.createElement("span");
  const details = document.createElement("p");
  const sellerRow = document.createElement("div");
  const sellerLabel = document.createElement("span");
  const seller = document.createElement("strong");
  const remove = document.createElement("button");

  card.className = "product-card";
  media.className = "product-media";
  tag.className = "tag";
  body.className = "product-body";
  titleRow.className = "product-title-row";
  meta.className = "product-meta";
  details.className = "listing-details";
  sellerRow.className = "seller-row";
  remove.className = "delete-button full-width";

  image.src = validImageUrl(listing.image);
  image.alt = listing.title || "Posted item";
  image.loading = "lazy";
  image.onerror = () => {
    image.onerror = null;
    image.src = PLACEHOLDER_IMAGE;
  };
  tag.textContent = listing.tag || "Post";
  title.textContent = listing.title || "Untitled listing";
  price.textContent = money(Number(listing.price) || 0);
  tags.textContent = getListingTags(listing).join(" ");
  age.textContent = timeAgo(Number(listing.createdAt) || Date.now());
  details.textContent = listing.details || "Posted listing.";
  sellerLabel.textContent = "Seller";
  seller.textContent = listing.seller || "Player";
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove listing");
  remove.textContent = "Remove";

  media.append(image, tag);
  titleRow.append(title, price);
  meta.append(tags, age);
  sellerRow.append(sellerLabel, seller);
  body.append(titleRow, meta, details, sellerRow, remove);
  card.append(media, body);
  return card;
}

function validImageUrl(value) {
  const image = String(value || "").trim();
  if (
    image.startsWith("data:image/") ||
    image.startsWith("http://") ||
    image.startsWith("https://")
  ) {
    return image;
  }
  return PLACEHOLDER_IMAGE;
}

function filteredListings() {
  return state.listings
    .filter((listing) => {
      const tags = getListingTags(listing).join(" ");
      const haystack = `${listing.title} ${listing.seller} ${listing.details || ""} ${tags}`.toLowerCase();
      const matchesQuery = !state.query || haystack.includes(state.query);
      const matchesMode =
        state.mode === "market" ||
        (state.mode === "drops" && listing.tag === "Post") ||
        state.mode === "sellers";

      return matchesMode && matchesQuery;
    })
    .sort((a, b) => {
      if (state.mode === "sellers") return a.seller.localeCompare(b.seller);
      if (state.sort === "priceLow") return a.price - b.price;
      if (state.sort === "priceHigh") return b.price - a.price;
      return b.createdAt - a.createdAt;
    });
}

function viewTitle() {
  if (state.mode === "drops") return "Drops";
  if (state.mode === "sellers") return "Sellers";
  return "Market";
}

function removeListing(listingId) {
  if (!requireAuth()) return;

  state.listings = state.listings.filter((listing) => listing.id !== listingId);
  writeListings(state.listings);
  renderListings();
  toast("Listing removed.");
}

function normalizeTags(value) {
  const pieces = String(value)
    .split(/[\s,]+/)
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .map((tag) => tag.replace(/[^#a-z0-9_-]/g, ""))
    .filter((tag) => tag.length > 1);

  return [...new Set(pieces)].slice(0, 6);
}

function getListingTags(listing) {
  if (Array.isArray(listing.tags) && listing.tags.length > 0) return listing.tags;
  if (listing.category) return normalizeTags(listing.category);
  return ["#item"];
}

function readListings() {
  try {
    const saved = JSON.parse(localStorage.getItem("blopbox_listings") || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function writeListings(listings) {
  localStorage.setItem("blopbox_listings", JSON.stringify(listings));
}

function money(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(amount);
}

function timeAgo(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2600);
}
