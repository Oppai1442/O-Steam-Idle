# GitHub → Cloudflare Containers deployment (persistent idle)

**Requirements:** Workers Paid plan, GitHub access and a Steam refresh token. The Worker controls one singleton Container; the Durable Object stores non-secret app selection, Priority and whether idle was armed. The container filesystem is ephemeral.

## Owner-only security: Cloudflare Access (required on security branch)

**Configure Access and Worker secrets BEFORE deploying this branch.** This version fails closed (HTTP 403) if ANY required Access setting is missing. That is deliberate: a deployed dashboard must never silently become public.

1. In **Cloudflare Dashboard → Workers & Pages → o-steam-idle → Settings → Access**, enable Cloudflare Access for this Worker. The Cloudflare One / Zero Trust > Access controls > Applications route also supports creating a Worker Access app. Select **production** and protect **preview URLs** too if used, and ensure any Custom Domain/route is covered.
2. Set the Access policy action to **Allow**, with **Include → Emails → exactly your personal sign-in email**. Do not allow Everyone, a whole email domain or additional identities. Prefer a trusted identity provider (Google, etc.) with **passkeys or strong MFA**. In Access organization/application MFA settings, require a FIDO2 security key or authenticator, and use a short application session duration. Store recovery factors securely.
3. In Cloudflare One **Access controls → Applications → your Access application → Configure / Additional settings**, copy the **Application Audience (AUD)** tag. Find your Access team domain, of the form `https://<your-team-name>.cloudflareaccess.com` (no trailing slash).
4. Under the **Worker's runtime encrypted secrets** (NOT build-time environment variables), set ALL the following:
   - `O_IDLE_ACCESS_TEAM_DOMAIN` — `https://<your-team-name>.cloudflareaccess.com`
   - `O_IDLE_ACCESS_AUD` — the exact Application AUD tag
   - `O_IDLE_ALLOWED_EMAIL` — the exact single owner email authenticated by Cloudflare Access
   - `O_IDLE_ACCESS_PASSWORD` — a unique high-entropy password as a second challenge (Basic Auth)
   - `STEAM_REFRESH_TOKEN` — your Steam credential, separate from Access identity (never put it into GitHub)
5. Redeploy the security branch. Cloudflare Access takes the first login; the Worker **independently verifies** the JWT signature against the team JWKS, expiration, issuer, AUD and email, then requires HTTP Basic Auth. Requests with missing/malformed configuration fail with 403. Credentials/JWTs are removed before proxying to the Node container.
6. **Verify in a private browsing window**: without an Access login the URL must redirect to Access or be denied; a different email must be denied; your owner account with MFA should reach the Basic Auth challenge; after Basic Auth, the dashboard works. Test `/api/status`, `/health`, the `workers.dev` hostname, custom routes and previews. Check both GET and POST endpoints. Never post raw JWTs, Steam secrets or Basic Auth passwords to issues/logs.

This Worker also enforces same-origin mutations (CSRF protection), HTTPS, security response headers, and blocks direct access to `/api/cloud/`. Strong authentication does not guarantee an uncompromised device, stolen browser session or zero downtime; use passkeys/hardware keys, keep the machine up to date, and revoke lost sessions through Cloudflare.

**Important:** The Access application must actually be enabled at the Cloudflare edge. The Worker independently rejects missing/forged Access JWTs, but **will not display a sign-in page by itself**; Cloudflare Access performs that redirect. Do not rely on Basic Auth alone or deploy this fail-closed code without first setting all secrets.

Cloudflare docs:
- Worker integration: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- JWT verification and AUD: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Enforce MFA: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/
- Worker URL coverage: https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/

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
