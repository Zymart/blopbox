# Blopbox

A dark blue and purple gaming marketplace where players can post hashtagged listings for skins, items, accounts, boosts, passes, collectibles, and other game services.

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
