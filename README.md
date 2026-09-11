# O-Steam-Idle

A local-first Steam presence/playtime controller for idling multiple AppIDs from one lightweight Node.js process. It includes QR authentication, library selection, card-drop visibility, session coexistence handling, manual AppIDs for F2P edge cases, and an optional Cloudflare Container deployment.

The UI is intentionally dependency-free: plain HTML/CSS/JS, no frontend framework, no external font bundle, and no heavy visual effects.

> Unofficial Steam utility. Not affiliated with Valve.

## What it does

- Reports selected Steam AppIDs as currently played without launching each game executable.
- Runs one `steam-user` session for the entire selected set.
- Steam Mobile QR login with persistent refresh-token support.
- On Windows, local refresh tokens are protected with DPAPI (`CurrentUser`).
- Scans owned/profile-played games and lets you add explicit AppIDs when Steam omits an F2P title from ownership APIs.
- Scans authenticated Steam Community badge pages for card games and remaining drops.
- Yields when another Steam session actually starts playing a game.
- Reconnects after temporary Steam CM/network disconnects and restores an active idle set.
- Supports local Windows use and a Cloudflare Container deployment.

## Local Windows quick start

Requirements: Node.js 20+ and Steam Mobile for the first QR login.

1. Download/clone the repository.
2. Double-click `start.bat`.
3. The browser opens at `http://127.0.0.1:3210`.
4. Click **Login with QR**, scan with Steam Mobile, and approve.
5. Select games and click **Start idle**.

Or run it manually:

```powershell
npm install
npm start
```

### Hidden start / clean stop

- `start.bat` — normal console, installs missing dependencies and starts the server.
- `start-hidden.vbs` — starts Node with no console window. Run `start.bat` once first.
- `stop.bat` — asks the local server to stop idling, log off, close HTTP, and exit cleanly.
- **Exit server** in the UI does the same thing.

## Library discovery and manual AppIDs

Steam does not expose every F2P/free-on-demand library entry consistently through the same API. O-Steam-Idle keeps automatic discovery conservative rather than importing unrelated catalog/cache entries.

If a known game is missing, click **+ AppID** and paste its Steam AppID. Manual AppIDs are saved in `data/settings.json` locally and merged into the normal library. PICS metadata is used to resolve the game name when available.

The **Copy AppIDs** button copies the current selection as a comma-separated list. This is also the easiest way to configure Cloudflare auto-start.

## Trading cards

The card scanner uses the authenticated Steam Community badge pages. It marks:

- games with badge/card rows,
- remaining normal card drops,
- completed/no-drop rows,
- unknown games that do not appear on the scanned badge pages.

**Select drops** selects only games with at least one remaining parsed drop. Card information is advisory; Steam ultimately decides eligibility and drop scheduling.

## Steam session coexistence

- Uses a stable non-zero `logonID` to reduce same-account/same-IP session collisions.
- `steam-user` auto-relogin remains enabled for temporary network/Steam CM outages.
- If another Steam session starts a game, O-Steam-Idle stops its idle set and yields.
- It does not force-kick another Steam session.
- After yielding to a real playing session, idle remains stopped until manually started again.

Diagnostics are written to `data/runtime.log` locally and rotate at roughly 2 MB. Refresh tokens and web cookies are not written to that log.

## Cloudflare Container mode

The repository includes a `Dockerfile` plus a Worker/Container deployment under `cloudflare/`.

Cloud mode uses:

```text
Browser -> Cloudflare Worker (Basic Auth) -> singleton Container -> Node/steam-user -> Steam
```

For the full setup, including Worker secrets, token export, Docker/Wrangler commands, and automatic idle recovery after a fresh container boot, read [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).

Short version:

```powershell
# First create/save a Steam login locally
npm install
npm start
npm run token:export

# Then deploy the container
cd cloudflare
npm install
npx wrangler login
npx wrangler secret put O_IDLE_ACCESS_PASSWORD
npx wrangler secret put STEAM_REFRESH_TOKEN
npx wrangler deploy
```

Cloudflare Container disk is ephemeral, so the durable cloud credential source is the `STEAM_REFRESH_TOKEN` Worker secret. Set `O_IDLE_DEFAULT_APPIDS` and `O_IDLE_AUTO_START=1` in `cloudflare/wrangler.jsonc` if you want the idle set to restart automatically after a completely fresh container boot.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3210` |
| `O_IDLE_HOST` | Bind address | `127.0.0.1` local / `0.0.0.0` cloud |
| `O_IDLE_CLOUD` | Enable cloud runtime behavior | `0` |
| `O_IDLE_DISABLE_BROWSER` | Do not auto-open a local browser | `0` |
| `STEAM_REFRESH_TOKEN` | External refresh-token source (used by cloud) | empty |
| `O_IDLE_DEFAULT_APPIDS` | Comma/space separated default AppIDs | empty |
| `O_IDLE_AUTO_START` | Auto-start default AppIDs after Steam login | `0` |

## Security

- Local mode binds to `127.0.0.1` by default.
- The refresh token is never returned by the browser API.
- Windows local credentials use DPAPI CurrentUser protection.
- `npm run token:export` deliberately prints the decrypted token for Cloudflare secret setup; treat the output like a password.
- Cloud deployment requires `O_IDLE_ACCESS_PASSWORD` and keeps the Worker authentication layer in front of the container.
- Never commit `data/`, `.env`, `.dev.vars`, or refresh tokens.

## Project layout

```text
app.js                     Node / Steam backend
public/                    Lightweight gaming UI
scripts/export-refresh-token.js
Dockerfile                 Container image
cloudflare/                Worker + Container deployment
  src/index.js
  wrangler.jsonc
docs/CLOUDFLARE.md         Cloud setup guide
```
