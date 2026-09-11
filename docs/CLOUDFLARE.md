# Cloudflare Container deployment

O-Steam-Idle can run as one long-lived Cloudflare Container behind a Worker. The Worker is the public control-plane endpoint; the Node process inside the container keeps the Steam CM session alive.

> Cloudflare Containers require a Workers Paid plan. Docker must be running when `wrangler deploy` builds the image.

## Architecture

```text
Browser
  │  HTTPS + Basic Auth
  ▼
Cloudflare Worker
  │  singleton Durable Object / Container
  ▼
O-Steam-Idle Node server :3210
  │
  └── Steam CM + Steam Community
```

The Worker always routes to the same named container (`primary`) and protects the UI with HTTP Basic Auth. The username is fixed to `o-steam-idle`; the password is a Worker secret you choose.

The container is configured to stay alive instead of using the normal idle sleep behavior. Cloudflare can still restart it during host maintenance or a deployment, so use `O_IDLE_DEFAULT_APPIDS` + `O_IDLE_AUTO_START=1` if you want automatic recovery after a fresh container boot.

## 1. Get a Steam refresh token locally

Do this on the PC where O-Steam-Idle is already logged in:

```powershell
npm install
npm start
```

Log in with the Steam Mobile QR once, then stop the app and run:

```powershell
npm run token:export
```

The command prints the refresh token. Treat it like a password. Do not commit it, paste it into issues, or store it in `wrangler.jsonc`.

## 2. Configure the Cloudflare Worker

```powershell
cd cloudflare
npm install
npx wrangler login
```

Set the web UI password:

```powershell
npx wrangler secret put O_IDLE_ACCESS_PASSWORD
```

Use a reasonably long ASCII password. The browser username will be:

```text
o-steam-idle
```

Store the Steam refresh token:

```powershell
npx wrangler secret put STEAM_REFRESH_TOKEN
```

## 3. Optional: auto-idle after container restarts

In the local UI, select the games you want and click **Copy AppIDs**. Paste the resulting comma-separated list into `cloudflare/wrangler.jsonc`:

```jsonc
"vars": {
  "O_IDLE_AUTO_START": "1",
  "O_IDLE_DEFAULT_APPIDS": "346110,2399830"
}
```

`O_IDLE_DEFAULT_APPIDS` is not a secret. It is only a list of Steam AppIDs.

If you leave auto-start disabled, the cloud UI still works normally, but a brand-new container instance will reconnect to Steam without automatically starting an idle set.

## 4. Deploy

Make sure Docker Desktop (or another compatible Docker engine) is running:

```powershell
docker info
npx wrangler deploy
```

Wrangler builds `../Dockerfile`, pushes the image, deploys the Worker, and prints a `workers.dev` URL. The first container provisioning can take a few minutes.

Open the URL and authenticate with:

```text
username: o-steam-idle
password: <O_IDLE_ACCESS_PASSWORD>
```

Useful commands:

```powershell
npx wrangler containers list
npx wrangler tail
```

## Updating

Pull/update the repository, then redeploy from `cloudflare/`:

```powershell
npm install
npx wrangler deploy
```

The rollout can replace the running container. If auto-start is enabled, the new process uses the secret refresh token and restarts the configured idle set after login/library discovery.

## Security and persistence notes

- The public Worker endpoint is protected by Basic Auth. For a more elaborate deployment you can additionally put Cloudflare Access in front of it.
- `STEAM_REFRESH_TOKEN` is a Worker secret and is passed to the container as a runtime environment variable.
- Container disk is ephemeral. O-Steam-Idle does **not** rely on the cloud container's `data/credentials.dat` surviving a restart.
- A refresh token renewed by Steam during a live container session can be written to ephemeral disk, but it cannot automatically rewrite your Cloudflare Worker secret. If a future clean boot stops accepting the old secret, export a fresh token locally and run `wrangler secret put STEAM_REFRESH_TOKEN` again.
- `data/settings.json` is durable on local Windows but ephemeral in a Cloudflare Container. Use `O_IDLE_DEFAULT_APPIDS` for the cloud idle set you want restored after a fresh boot.
- Do not expose the Node container directly to the Internet. Keep the Worker authentication layer in front of it.

## Cloudflare references

- Containers get started: https://developers.cloudflare.com/containers/get-started/
- Container class / lifecycle: https://developers.cloudflare.com/containers/reference/container-class/
- Environment variables and secrets: https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/
- Containers FAQ / ephemeral disk: https://developers.cloudflare.com/containers/faq/
