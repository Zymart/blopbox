const PLACEHOLDER_IMAGE =
  "https://images.unsplash.com/photo-1603481546579-65d935ba9cdd?auto=format&fit=crop&w=900&q=80";
const AUTH_SERVER_PORT = "3000";
const API_ORIGIN = resolveApiOrigin();
const MAX_PRODUCTS_PER_USER = 3;
const HOME_RECOMMENDATION_LIMIT = 10;

const state = {
  authConfig: null,
  authMessage: "",
  exchangeRate: {
    base: "USD",
    currency: "USD",
    countryCode: "",
    rate: 1
  },
  mode: "market",
  query: "",
  sort: "newest",
  listings: [],
  activeListingId: "",
  replyingToCommentId: "",
  expandedReplyIds: new Set(),
  user: null
};

const elements = {
  accountControls: document.querySelector("#accountControls"),
  authStatus: document.querySelector("#authStatus"),
  browseHeroButton: document.querySelector("#browseHeroButton"),
  closeDetailsButton: document.querySelector("#closeDetailsButton"),
  closePostButton: document.querySelector("#closePostButton"),
  commentForm: document.querySelector("#commentForm"),
  commentHint: document.querySelector("#commentHint"),
  commentText: document.querySelector("#commentText"),
  checkoutButton: document.querySelector("#checkoutButton"),
  commentsList: document.querySelector("#commentsList"),
  detailsAge: document.querySelector("#detailsAge"),
  detailsCopy: document.querySelector("#detailsCopy"),
  detailsImage: document.querySelector("#detailsImage"),
  detailsOverlay: document.querySelector("#detailsOverlay"),
  detailsPrice: document.querySelector("#detailsPrice"),
  detailsSeller: document.querySelector("#detailsSeller"),
  detailsSellerMeta: document.querySelector("#detailsSellerMeta"),
  detailsTags: document.querySelector("#detailsTags"),
  detailsTitle: document.querySelector("#detailsTitle"),
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
  listingSubtitle: document.querySelector("#listingSubtitle"),
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
  sellerRating: document.querySelector("#sellerRating"),
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
  await hydrateExchangeRate();
  if (state.user) await hydrateProducts();
  renderAuth();
  activateMode(state.mode);
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
  elements.closeDetailsButton.addEventListener("click", closeDetails);
  elements.checkoutButton.addEventListener("click", () => startCheckout(state.activeListingId));
  elements.logoutButton.addEventListener("click", logout);

  elements.postOverlay.addEventListener("click", (event) => {
    if (event.target === elements.postOverlay) closePostForm();
  });

  elements.detailsOverlay.addEventListener("click", (event) => {
    if (event.target === elements.detailsOverlay) closeDetails();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.postOverlay.hidden) closePostForm();
    if (event.key === "Escape" && !elements.detailsOverlay.hidden) closeDetails();
  });

  elements.listingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await addListing();
  });

  elements.commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await addComment();
  });

  elements.commentsList.addEventListener("click", (event) => {
    const replyButton = event.target.closest("[data-reply-to]");
    if (replyButton) {
      state.replyingToCommentId = replyButton.dataset.replyTo || "";
      renderDetails();
      const replyText = elements.commentsList.querySelector(".reply-form textarea");
      if (replyText) replyText.focus();
      return;
    }

    if (event.target.closest("[data-cancel-reply]")) {
      state.replyingToCommentId = "";
      renderDetails();
    }

    const repliesButton = event.target.closest("[data-toggle-replies]");
    if (repliesButton) {
      const commentId = repliesButton.dataset.toggleReplies || "";
      if (state.expandedReplyIds.has(commentId)) state.expandedReplyIds.delete(commentId);
      else state.expandedReplyIds.add(commentId);
      renderDetails();
    }
  });

  elements.commentsList.addEventListener("submit", async (event) => {
    if (!event.target.classList.contains("reply-form")) return;
    event.preventDefault();
    await addReply(event.target.dataset.commentId || "", event.target.elements.replyText.value);
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
  if (elements.sortSelect) {
    const sortControl = elements.sortSelect.closest(".sort-control");
    if (sortControl) sortControl.hidden = mode !== "drops";
  }
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

async function hydrateExchangeRate() {
  const countryCode = cleanCountryCode((state.user && state.user.countryCode) || browserCountryCode());
  const currency = currencyForCountry(countryCode);
  state.exchangeRate = {
    base: "USD",
    currency,
    countryCode,
    rate: 1
  };

  if (!countryCode || currency === "USD") return;

  try {
    const params = new URLSearchParams({ country: countryCode, currency });
    const exchange = await fetchJson(`/api/exchange-rate?${params.toString()}`);
    state.exchangeRate = {
      base: exchange.base || "USD",
      currency: exchange.currency || currency,
      countryCode: exchange.countryCode || countryCode,
      rate: Number(exchange.rate) || 1,
      date: exchange.date || ""
    };
  } catch {
    state.exchangeRate = {
      base: "USD",
      currency,
      countryCode,
      rate: 1
    };
  }
}

async function fetchJson(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(apiUrl(path), {
    ...options,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const error = await response.json();
      if (error && error.error) message = error.error;
    } catch {
      // Keep the status message if the server did not send JSON.
    }
    throw new Error(message);
  }

  return response.json();
}

function sendJson(path, method, body) {
  return fetchJson(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function hydrateProducts() {
  const localProducts = readListings();

  try {
    const data = await fetchJson("/api/products");
    let products = Array.isArray(data.products) ? data.products : [];

    if (data.storageConfigured === false) {
      state.listings = mergeListings(products, localProducts);
      toast("Product storage is not connected yet, so products will stay on one device.");
      return;
    }

    if (localProducts.length > 0) {
      products = await migrateLocalProducts(localProducts, products);
    }

    state.listings = mergeListings(products);
  } catch (error) {
    state.listings = localProducts;
    if (localProducts.length > 0) {
      toast("Products are saved only on this device until the server can save them.");
    }
    console.warn(error);
  }
}

async function migrateLocalProducts(localProducts, serverProducts) {
  const serverIds = new Set(serverProducts.map((product) => product.id));
  let next = serverProducts;
  let movedAny = false;
  let failedAny = false;

  for (const product of localProducts) {
    if (!product || serverIds.has(product.id)) continue;

    try {
      const saved = await sendJson("/api/products", "POST", product);
      if (saved && saved.product) {
        next = mergeListings([saved.product], next);
        serverIds.add(saved.product.id);
        movedAny = true;
      }
    } catch (error) {
      failedAny = true;
      console.warn(error);
    }
  }

  if (movedAny && !failedAny) {
    clearListings();
    toast("Your saved products are now shared across devices.");
  }

  return failedAny ? mergeListings(next, localProducts) : next;
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
  const provider = state.user.provider || "account";
  const countryCode = cleanCountryCode(state.user.countryCode || browserCountryCode());
  elements.userName.textContent = name;
  elements.userProvider.textContent = "";
  elements.userProvider.append(provider);
  if (countryCode) elements.userProvider.append(renderCountryFlag(countryCode));
  elements.userProvider.title = countryCode ? `${provider} account` : "";
  renderUserAvatar(name);
}

function browserCountryCode() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const timezoneCountries = {
    "Asia/Manila": "PH"
  };
  if (timezoneCountries[timezone]) return timezoneCountries[timezone];

  try {
    const locale = new Intl.Locale(navigator.language || "");
    if (locale.region) return locale.region;
  } catch {
    // Fall through to timezone hints when the browser locale has no region.
  }

  return "";
}

function cleanCountryCode(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function renderCountryFlag(countryCode) {
  const code = countryCode.toLowerCase();
  const image = document.createElement("img");
  image.className = "country-flag";
  image.alt = `${countryCode} flag`;
  image.loading = "lazy";
  image.src = `https://flagcdn.com/24x18/${code}.png`;
  image.srcset = `https://flagcdn.com/48x36/${code}.png 2x`;
  image.onerror = () => image.remove();
  return image;
}

function currencyForCountry(countryCode) {
  const currencies = {
    AE: "AED",
    AR: "ARS",
    AT: "EUR",
    AU: "AUD",
    BD: "BDT",
    BE: "EUR",
    BG: "BGN",
    BH: "BHD",
    BN: "BND",
    BR: "BRL",
    CA: "CAD",
    CH: "CHF",
    CL: "CLP",
    CN: "CNY",
    CO: "COP",
    CZ: "CZK",
    DE: "EUR",
    DK: "DKK",
    EG: "EGP",
    ES: "EUR",
    FI: "EUR",
    FR: "EUR",
    GB: "GBP",
    GR: "EUR",
    HK: "HKD",
    HR: "EUR",
    HU: "HUF",
    ID: "IDR",
    IE: "EUR",
    IL: "ILS",
    IN: "INR",
    IT: "EUR",
    JP: "JPY",
    KR: "KRW",
    KW: "KWD",
    LK: "LKR",
    MX: "MXN",
    MY: "MYR",
    NG: "NGN",
    NL: "EUR",
    NO: "NOK",
    NZ: "NZD",
    PH: "PHP",
    PK: "PKR",
    PL: "PLN",
    PT: "EUR",
    QA: "QAR",
    RO: "RON",
    SA: "SAR",
    SE: "SEK",
    SG: "SGD",
    TH: "THB",
    TR: "TRY",
    TW: "TWD",
    US: "USD",
    VN: "VND",
    ZA: "ZAR"
  };
  return currencies[cleanCountryCode(countryCode)] || "USD";
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
  if (!canPostProduct()) {
    toast("You can only post up to 3 products.");
    return;
  }

  if (!elements.itemSeller.value.trim() && state.user) {
    elements.itemSeller.value = state.user.globalName || state.user.username || "";
  }

  elements.postOverlay.hidden = false;
  elements.itemTitle.focus();
}

function closePostForm() {
  elements.postOverlay.hidden = true;
}

function openDetails(listingId) {
  state.activeListingId = listingId;
  renderDetails();
  elements.detailsOverlay.hidden = false;
}

function closeDetails() {
  elements.detailsOverlay.hidden = true;
  state.activeListingId = "";
  state.replyingToCommentId = "";
  state.expandedReplyIds.clear();
  elements.commentForm.reset();
}

function activeListing() {
  return state.listings.find((listing) => listing.id === state.activeListingId) || null;
}

function renderDetails() {
  const listing = activeListing();
  if (!listing) {
    closeDetails();
    return;
  }

  const comments = getListingComments(listing);
  const sellerMeta = listing.ownerName || listing.seller || "Seller";
  const isOwner = canRemoveListing(listing);

  elements.detailsTitle.textContent = listing.title || "Product Details";
  elements.detailsImage.onerror = () => {
    elements.detailsImage.onerror = null;
    elements.detailsImage.src = PLACEHOLDER_IMAGE;
  };
  elements.detailsImage.src = validImageUrl(listing.image);
  elements.detailsImage.alt = listing.title || "Product image";
  elements.detailsPrice.textContent = money(Number(listing.price) || 0);
  elements.detailsAge.textContent = timeAgo(Number(listing.createdAt) || Date.now());
  elements.detailsCopy.textContent = listing.details || "No extra details yet.";
  elements.detailsSeller.textContent = listing.seller || sellerMeta;
  elements.detailsSellerMeta.textContent = sellerMeta;
  elements.sellerRating.textContent = "Comments only";
  elements.checkoutButton.hidden = isOwner;
  elements.checkoutButton.disabled = !stripeReady();
  elements.checkoutButton.textContent = stripeReady() ? "Buy with Stripe" : "Stripe setup needed";

  elements.detailsTags.innerHTML = "";
  for (const tag of getListingTags(listing)) {
    const badge = document.createElement("span");
    badge.textContent = tag;
    elements.detailsTags.append(badge);
  }

  renderComments(comments);
  elements.commentForm.hidden = false;
  elements.commentHint.textContent = isOwner ? "You own this product. You can still comment and reply." : "";
}

function renderComments(comments) {
  elements.commentsList.innerHTML = "";

  if (comments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "comment-empty";
    empty.textContent = "No comments yet.";
    elements.commentsList.append(empty);
    return;
  }

  for (const comment of comments) {
    const card = document.createElement("article");
    const header = document.createElement("div");
    const identity = document.createElement("div");
    const authorAvatar = createCommentAvatar(comment.authorName, comment.authorAvatar);
    const author = document.createElement("strong");
    const meta = document.createElement("span");
    const text = document.createElement("p");
    const actions = document.createElement("div");
    const replyButton = document.createElement("button");
    const repliesButton = document.createElement("button");
    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    const expanded = state.expandedReplyIds.has(comment.id);

    card.className = "comment-card";
    header.className = "comment-header";
    identity.className = "comment-identity";
    author.textContent = comment.authorName || "User";
    meta.textContent = timeAgo(Number(comment.createdAt) || Date.now());
    text.textContent = comment.text || "";
    actions.className = "comment-actions";
    replyButton.type = "button";
    replyButton.className = "text-button";
    replyButton.dataset.replyTo = comment.id || "";
    replyButton.textContent = "Reply";
    repliesButton.type = "button";
    repliesButton.className = "text-button";
    repliesButton.dataset.toggleReplies = comment.id || "";
    repliesButton.textContent = expanded
      ? `Hide replies (${replies.length})`
      : `View replies (${replies.length})`;

    identity.append(authorAvatar, author);
    header.append(identity, meta);
    if (replies.length > 0) actions.append(repliesButton);
    actions.append(replyButton);
    card.append(header, text, actions);
    if (replies.length > 0 && expanded) card.append(renderReplies(replies));
    if (state.replyingToCommentId === comment.id) card.append(renderReplyForm(comment.id));
    elements.commentsList.append(card);
  }
}

function renderReplies(replies) {
  const list = document.createElement("div");
  list.className = "reply-list";

  for (const reply of replies) {
    const item = document.createElement("article");
    const header = document.createElement("div");
    const identity = document.createElement("div");
    const authorAvatar = createCommentAvatar(reply.authorName, reply.authorAvatar);
    const author = document.createElement("strong");
    const meta = document.createElement("span");
    const text = document.createElement("p");

    item.className = "reply-card";
    header.className = "comment-header";
    identity.className = "comment-identity";
    author.textContent = reply.authorName || "User";
    meta.textContent = timeAgo(Number(reply.createdAt) || Date.now());
    text.textContent = reply.text || "";

    identity.append(authorAvatar, author);
    header.append(identity, meta);
    item.append(header, text);
    list.append(item);
  }

  return list;
}

function renderReplyForm(commentId) {
  const form = document.createElement("form");
  const label = document.createElement("label");
  const textarea = document.createElement("textarea");
  const controls = document.createElement("div");
  const cancelButton = document.createElement("button");
  const submitButton = document.createElement("button");

  form.className = "reply-form";
  form.dataset.commentId = commentId;
  label.textContent = "Reply";
  textarea.name = "replyText";
  textarea.maxLength = 220;
  textarea.placeholder = "Write a short reply";
  controls.className = "reply-controls";
  cancelButton.type = "button";
  cancelButton.className = "ghost-button";
  cancelButton.dataset.cancelReply = "true";
  cancelButton.textContent = "Cancel";
  submitButton.type = "submit";
  submitButton.className = "primary-button";
  submitButton.textContent = "Post Reply";

  label.append(textarea);
  controls.append(cancelButton, submitButton);
  form.append(label, controls);
  return form;
}

function createCommentAvatar(name, avatar) {
  const image = document.createElement("img");
  const label = name || "User";
  const fallback = initialAvatar(label, "comment");
  const source = String(avatar || "").trim();

  image.className = "comment-avatar";
  image.alt = `${label} profile picture`;
  image.referrerPolicy = "no-referrer";
  image.onerror = () => {
    image.onerror = null;
    image.src = fallback;
  };
  image.src = source || fallback;
  return image;
}

async function addComment() {
  if (!requireAuth()) return;
  const listing = activeListing();
  if (!listing) return;

  const text = elements.commentText.value.trim();
  if (!text) {
    toast("Add a comment first.");
    return;
  }

  try {
    const saved = await sendJson("/api/products/comment", "POST", {
      productId: listing.id,
      text
    });
    if (saved && saved.product) replaceListing(saved.product);
    elements.commentForm.reset();
    renderListings();
    renderDetails();
    toast("Comment posted.");
  } catch (error) {
    toast(error.message || "Could not post comment.");
  }
}

async function addReply(commentId, textValue) {
  if (!requireAuth()) return;
  const listing = activeListing();
  if (!listing || !commentId) return;

  const text = String(textValue || "").trim();
  if (!text) {
    toast("Write a reply first.");
    return;
  }

  try {
    const saved = await sendJson("/api/products/comment", "POST", {
      productId: listing.id,
      parentCommentId: commentId,
      text
    });
    if (saved && saved.product) replaceListing(saved.product);
    state.replyingToCommentId = "";
    renderListings();
    renderDetails();
    toast("Reply posted.");
  } catch (error) {
    toast(error.message || "Could not post reply.");
  }
}

async function startCheckout(productId, button = elements.checkoutButton) {
  if (!requireAuth()) return;
  if (!stripeReady()) {
    toast("Stripe payments need STRIPE_SECRET_KEY in the server environment.");
    return;
  }
  const listing = state.listings.find((item) => item.id === productId);
  if (!listing) {
    toast("Product was not found.");
    return;
  }
  if (canRemoveListing(listing)) {
    toast("You cannot buy your own product.");
    return;
  }

  const previousText = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Opening Stripe...";
  }

  try {
    const checkout = await sendJson("/api/checkout", "POST", {
      productId: listing.id,
      countryCode: cleanCountryCode(state.exchangeRate.countryCode || browserCountryCode()),
      currency: state.exchangeRate.currency || "USD",
      returnTo: appReturnUrl()
    });
    if (!checkout.url) throw new Error("Stripe did not return a checkout link.");
    window.location.href = checkout.url;
  } catch (error) {
    toast(error.message || "Could not start Stripe checkout.");
    if (button) {
      button.disabled = false;
      button.textContent = previousText || "Buy with Stripe";
    }
  }
}

async function addListing() {
  if (!requireAuth()) return;
  if (!canPostProduct()) {
    toast("You can only post up to 3 products.");
    return;
  }

  const title = elements.itemTitle.value.trim();
  const seller = elements.itemSeller.value.trim();
  const tags = normalizeTags(elements.itemTags.value);
  const price = Number(elements.itemPrice.value);
  const details = elements.itemDetails.value.trim();

  if (!title || !seller || tags.length === 0 || !Number.isFinite(price) || price <= 0) {
    toast("Fill in the required product fields.");
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
    id: `product-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    seller,
    tags,
    price: Math.round(price),
    details,
    image,
    tag: "Post",
    createdAt: Date.now(),
    ownerId: currentUserKey(),
    ownerName: state.user.globalName || state.user.username || "Seller",
    comments: []
  };

  let postMessage = "Product posted to Blopbox.";

  try {
    const saved = await sendJson("/api/products", "POST", listing);
    const product = saved.product || listing;
    state.listings = mergeListings([product], state.listings);
    clearListings();
  } catch (error) {
    state.listings = [listing, ...state.listings];

    try {
      writeListings(state.listings);
    } catch {
      state.listings = state.listings.filter((item) => item.id !== listing.id);
      toast("That image is too large to save. Try a smaller image.");
      return;
    }

    postMessage = error.message
      ? `${error.message} Product saved on this device only.`
      : "Product saved on this device only. Server storage is not ready.";
  }

  elements.listingForm.reset();
  elements.uploadFileName.textContent = "Choose from phone gallery, camera roll, or laptop files.";
  closePostForm();
  renderListings();
  toast(postMessage);
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
      const maxSide = 900;
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
      resolve(canvas.toDataURL("image/jpeg", 0.74));
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
  if (elements.listingSubtitle) elements.listingSubtitle.textContent = viewSubtitle();
  elements.productGrid.classList.toggle("is-recommendation-rail", state.mode === "market");
  renderPostLimit();
  elements.productGrid.innerHTML = "";

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const emptyTitle =
      state.mode === "market" ? "No products yet." : "No matching products.";
    const emptyCopy =
      state.mode === "market"
        ? "Post the first product to start the marketplace."
        : "Try another search or post the first product.";
    empty.innerHTML = `
      <strong>${emptyTitle}</strong>
      <span>${emptyCopy}</span>
      <button class="primary-button" type="button">Post Product</button>
    `;
    empty.querySelector("button").addEventListener("click", openPostForm);
    elements.productGrid.append(empty);
    return;
  }

  for (const listing of visible) {
    const card = listingCard(listing);
    const detailsButton = card.querySelector(".details-button");
    if (detailsButton) detailsButton.addEventListener("click", () => openDetails(listing.id));
    const checkoutButton = card.querySelector("[data-checkout-product]");
    if (checkoutButton) {
      checkoutButton.addEventListener("click", () => startCheckout(listing.id, checkoutButton));
    }
    const removeButton = card.querySelector(".delete-button");
    if (removeButton) removeButton.addEventListener("click", () => removeListing(listing.id));
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
  const actions = document.createElement("div");
  const detailsButton = document.createElement("button");
  const checkoutButton = document.createElement("button");
  const remove = document.createElement("button");

  card.className = "product-card";
  media.className = "product-media";
  tag.className = "tag";
  body.className = "product-body";
  titleRow.className = "product-title-row";
  meta.className = "product-meta";
  details.className = "listing-details";
  sellerRow.className = "seller-row";
  actions.className = "card-actions";
  detailsButton.className = "details-button";
  checkoutButton.className = "primary-button checkout-card-button";
  remove.className = "delete-button full-width";

  image.src = validImageUrl(listing.image);
  image.alt = listing.title || "Posted product";
  image.loading = "lazy";
  image.onerror = () => {
    image.onerror = null;
    image.src = PLACEHOLDER_IMAGE;
  };
  tag.textContent = listing.tag || "Post";
  title.textContent = listing.title || "Untitled product";
  price.textContent = money(Number(listing.price) || 0);
  tags.textContent = getListingTags(listing).join(" ");
  age.textContent = timeAgo(Number(listing.createdAt) || Date.now());
  details.textContent = listing.details || "Posted product.";
  sellerLabel.textContent = "Seller";
  seller.textContent = listing.seller || "Player";
  detailsButton.type = "button";
  detailsButton.textContent = "See Details";
  checkoutButton.type = "button";
  checkoutButton.dataset.checkoutProduct = listing.id || "";
  checkoutButton.disabled = !stripeReady();
  checkoutButton.textContent = stripeReady() ? "Buy" : "Stripe setup";
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove product");
  remove.textContent = "Remove";

  media.append(image, tag);
  titleRow.append(title, price);
  meta.append(tags, age);
  sellerRow.append(sellerLabel, seller);
  body.append(titleRow, meta, details, sellerRow);
  actions.append(detailsButton);
  if (!canRemoveListing(listing)) actions.append(checkoutButton);
  if (canRemoveListing(listing)) actions.append(remove);
  body.append(actions);
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
  const listings = state.listings
    .filter((listing) => {
      const tags = getListingTags(listing).join(" ");
      const haystack = `${listing.title} ${listing.seller} ${listing.details || ""} ${tags}`.toLowerCase();
      const matchesQuery = !state.query || haystack.includes(state.query);
      const matchesMode =
        state.mode === "market" ||
        state.mode === "drops" ||
        state.mode === "sellers";

      return matchesMode && matchesQuery;
    });

  if (state.mode === "market") {
    return listings
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      .slice(0, HOME_RECOMMENDATION_LIMIT);
  }

  return listings.sort((a, b) => {
    if (state.mode === "sellers") return a.seller.localeCompare(b.seller);
    if (state.sort === "priceLow") return a.price - b.price;
    if (state.sort === "priceHigh") return b.price - a.price;
    return b.createdAt - a.createdAt;
  });
}

function viewTitle() {
  if (state.mode === "drops") return "Browse";
  if (state.mode === "sellers") return "Sellers";
  return "Recommended";
}

function viewSubtitle() {
  if (state.mode === "drops") return "All products appear here. Use sort to scan the full market.";
  if (state.mode === "sellers") return "Browse products grouped by seller name.";
  return "Highest-rated products appear on Home.";
}

async function removeListing(listingId) {
  if (!requireAuth()) return;

  const previous = state.listings;
  state.listings = state.listings.filter((listing) => listing.id !== listingId);
  renderListings();

  try {
    await fetchJson(`/api/products?id=${encodeURIComponent(listingId)}`, { method: "DELETE" });
    removeLocalListing(listingId);
    if (state.activeListingId === listingId) closeDetails();
    toast("Product removed.");
  } catch (error) {
    state.listings = previous;
    renderListings();
    toast(error.message || "Could not remove product.");
  }
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

function getListingComments(listing) {
  if (!Array.isArray(listing.comments)) return [];
  return listing.comments
    .filter((comment) => comment && comment.text)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
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

function clearListings() {
  localStorage.removeItem("blopbox_listings");
}

function removeLocalListing(listingId) {
  const localProducts = readListings().filter((listing) => listing.id !== listingId);
  if (localProducts.length > 0) writeListings(localProducts);
  else clearListings();
}

function mergeListings(...groups) {
  const products = new Map();

  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const product of group) {
      if (!product || !product.id) continue;
      products.set(product.id, product);
    }
  }

  return [...products.values()].sort((a, b) => {
    return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  });
}

function replaceListing(product) {
  state.listings = mergeListings([product], state.listings.filter((listing) => listing.id !== product.id));
}

function currentUserKey() {
  if (!state.user) return "";
  return `${state.user.provider || "account"}:${state.user.id || state.user.email || state.user.username || "unknown"}`;
}

function canRemoveListing(listing) {
  if (!state.user) return false;
  return Boolean(listing.ownerId) && listing.ownerId === currentUserKey();
}

function stripeReady() {
  return Boolean(state.authConfig && state.authConfig.stripeConfigured);
}

function userProductCount() {
  if (!state.user) return 0;
  return state.listings.filter((listing) => canRemoveListing(listing)).length;
}

function canPostProduct() {
  return userProductCount() < MAX_PRODUCTS_PER_USER;
}

function renderPostLimit() {
  if (!state.user) return;
  const remaining = Math.max(0, MAX_PRODUCTS_PER_USER - userProductCount());
  const disabled = remaining === 0;
  elements.openPostButton.disabled = disabled;
  elements.openPostButton.title = disabled
    ? "You can only post up to 3 products."
    : `${remaining} product post${remaining === 1 ? "" : "s"} left.`;
  elements.sellHeroButton.disabled = disabled;
  elements.sellHeroButton.title = elements.openPostButton.title;
}

function money(amount) {
  const exchange = state.exchangeRate || {};
  const currency = exchange.currency || "USD";
  const rate = Number(exchange.rate) || 1;
  const convertedAmount = Number(amount || 0) * rate;
  const zeroDecimalCurrencies = new Set(["CLP", "HUF", "IDR", "JPY", "KRW", "PHP", "TWD", "VND"]);
  const maximumFractionDigits = zeroDecimalCurrencies.has(currency) ? 0 : 2;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits
  }).format(convertedAmount);
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
