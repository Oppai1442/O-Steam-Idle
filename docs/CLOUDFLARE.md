# GitHub → Cloudflare Containers deployment (persistent idle)

**Requirements:** Workers Paid plan, GitHub access and a Steam refresh token. The Worker controls one singleton Container; the Durable Object stores non-secret app selection, Priority and whether idle was armed. The container filesystem is ephemeral.

## One-time GitHub integration (no Docker required on your PC)

1. In Cloudflare **Workers & Pages**, create/connect a Worker to GitHub repository `Oppai1442/O-Steam-Idle`.
2. Under **Settings → Builds**, use the **repository root** as Root directory (`/`). Use **Build command** `npm ci --prefix cloudflare` and **Deploy command** `cd cloudflare && npx wrangler deploy`. The nested `cloudflare/wrangler.jsonc` points to `../Dockerfile` and uses the repository root as Docker build context.
3. Select the **production branch** (typically `main`). Avoid enabling full deployment from a feature branch into the same production Worker. Container images do not deploy on non-production `wrangler versions upload` previews.
4. In Worker **Settings → Variables and Secrets**, add **encrypted secrets**, not build variables: `O_IDLE_ACCESS_PASSWORD` (web Basic Auth) and `STEAM_REFRESH_TOKEN` (the Steam refresh token).
5. Re-run deploy after the runtime secrets are saved if your first deploy required them. Open the resulting Worker URL. Basic Auth username: `o-steam-idle`, password: your secret.

For Steam refresh token, authenticate via local O-Steam-Idle QR login once, then run `npm run token:export` on that same Windows user account. **Never commit, paste into chat, or put a token in `wrangler.jsonc`.**

For automatic idle on the very first boot, set these **non-secret** `vars` in `cloudflare/wrangler.jsonc` before deployment:

```jsonc
"vars": {
  "O_IDLE_AUTO_START": "1",
  "O_IDLE_DEFAULT_APPIDS": "346110,2399830",
  "O_IDLE_PRIORITY_APPIDS": "346110"
}
```

On the first container boot, Cloudflare seeds its Durable Object storage from those defaults. Subsequent dashboard changes supersede the initial defaults and survive container replacement: selection, manual AppIDs, Priority and **Start/Stop intent**. A manual Stop remains stopped on restart; an armed idle set resumes after Steam reconnect/library discovery, subject to Steam's concurrent-session protection. Changes to `vars` do **not** override already saved settings. For a fresh deployment/new named Container instance, they are applied again.

## Notes and limitations

- Steam tokens are Worker secrets, not Durable Object state. Renewal inside the container does not automatically rotate the Worker secret. If Steam revokes it, update the secret manually.
- Persistent state is saved through the Worker only after successful dashboard mutation responses; every mutation writes a snapshot to Durable Object storage. If storage persistence fails, the UI request returns an error, and the previous persisted state may remain.
- Cloudflare Containers can be restarted during deploy/maintenance, and image builds and cold starts require time. The system cannot guarantee 100% uptime or playtime accrual.
- Do not expose Node's container port directly or allow access to `/api/cloud/`; the Worker blocks these internal paths.
- The existing CI verifies TypeScript, unit tests, local build and Worker typecheck. Actual Cloudflare deployment and Steam logon require your own Cloudflare account and secrets.
- Cloudflare pricing and Workers Builds UI may change: verify the current requirements before deploying.

## Alternative local deployment

```powershell
cd cloudflare
npm ci
npx wrangler login
npx wrangler secret put O_IDLE_ACCESS_PASSWORD
npx wrangler secret put STEAM_REFRESH_TOKEN
npx wrangler deploy
```

For production, use one Worker name and one singleton Container to avoid competing Steam sessions.
