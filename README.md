# Blopbox

A dark blue and purple gaming marketplace where players can post hashtagged products for skins, items, accounts, boosts, passes, collectibles, and other game services.

## Run

```bash
npm start
```

Open `http://localhost:3000`.

The marketplace now requires login before it shows the app. Add either Discord or Google OAuth credentials to `.env`, then restart the server.

Discord callback URL:

```text
http://localhost:3000/auth/discord/callback
```

In the Discord Developer Portal, add that exact URL under OAuth2 redirects. Use `localhost`, not `127.0.0.1` or the Live Server URL.

Google callback URL:

```text
http://localhost:3000/auth/google/callback
```

## Notes

Player posts, hashtags, and uploaded images are saved in browser local storage for now, so they are local to the device/browser.

## Cloudflare Pages

Use these Pages build settings:

```text
Framework preset: None
Build command: leave blank
Build output directory: public
```

The `functions` folder handles `/auth/*` and `/api/*` on Cloudflare. Add these environment variables in Cloudflare Pages settings:

```text
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
DISCORD_REDIRECT_URI=https://your-pages-domain.pages.dev/auth/discord/callback
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=https://your-pages-domain.pages.dev/auth/google/callback
SESSION_SECRET=make-this-a-long-random-secret
FRONTEND_ORIGINS=https://your-pages-domain.pages.dev
```

Also add the exact same callback URLs in the Discord Developer Portal and Google Cloud OAuth redirect settings.
