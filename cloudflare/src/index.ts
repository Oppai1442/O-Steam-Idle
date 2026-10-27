import { Container, getContainer } from '@cloudflare/containers';
import { env as workerEnv } from 'cloudflare:workers';
import { initialCloudConfig, normalizeCloudConfig, type CloudIdleConfig } from './cloud-state';

const BASIC_USER = 'o-steam-idle';

interface Env {
  O_IDLE_ACCESS_PASSWORD: string;
  O_IDLE_AUTO_START?: string;
  O_IDLE_DEFAULT_APPIDS?: string;
  O_IDLE_PRIORITY_APPIDS?: string;
  STEAM_REFRESH_TOKEN?: string;
  O_STEAM_IDLE: any;
}

const runtimeEnv = workerEnv as unknown as Env;

export class OSteamIdleContainer extends Container {
  defaultPort = 3210;
  sleepAfter = '1h';
  enableInternet = true;
  envVars = {
    O_IDLE_CLOUD: '1',
    O_IDLE_HOST: '0.0.0.0',
    O_IDLE_DISABLE_BROWSER: '1',
    O_IDLE_AUTO_START: runtimeEnv.O_IDLE_AUTO_START || '0',
    O_IDLE_DEFAULT_APPIDS: '',
    O_IDLE_PRIORITY_APPIDS: '',
    STEAM_REFRESH_TOKEN: runtimeEnv.STEAM_REFRESH_TOKEN || ''
  };

  async onActivityExpired() {
    // O-Steam-Idle is a long-lived Steam CM session. Intentionally do not call
    // stop() here. Cloudflare renews the activity timer when this hook returns.
    // This keeps the singleton container alive until a rollout/host restart.
  }

  async onStart() {
    console.log('O-Steam-Idle container started; restoring durable idle configuration');
    const saved = await this.ctx.storage.get<CloudIdleConfig>('cloud_idle_config_v1');
    const config = saved ? normalizeCloudConfig(saved) : initialCloudConfig(runtimeEnv);
    if (!saved) await this.ctx.storage.put('cloud_idle_config_v1', config);
    const result = await this.containerFetch('http://localhost:3210/api/cloud/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    if (!result.ok) throw new Error('Cloud idle bootstrap failed: ' + result.status);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/cloud/')) return new Response('Not found', { status: 404 });
    const response = await super.fetch(request);
    const durableMutation = request.method === 'POST' && [
      '/api/selection', '/api/priority', '/api/library/manual',
      '/api/idle/start', '/api/idle/stop'
    ].includes(pathname);
    if (durableMutation && response.ok) {
      // Read the authoritative Node runtime snapshot after the mutation.
      // This avoids storing secrets or guessing how a request changed state.
      try {
        const snapshot = await this.containerFetch('http://localhost:3210/api/cloud/state');
        if (snapshot.ok) {
          await this.ctx.storage.put('cloud_idle_config_v1', normalizeCloudConfig(await snapshot.json()));
        }
      } catch (err) {
        console.error('Unable to persist cloud idle state', String(err));
        // A successful UI action is not proof it will survive a restart.
        return new Response('Unable to persist cloud settings; retry the action', { status: 503 });
      }
    }
    return response;
  }

  onStop({ exitCode, reason }: { exitCode?: number; reason?: string }) {
    console.log('O-Steam-Idle container stopped', { exitCode, reason });
  }
}

function unauthorized(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="O-Steam-Idle", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow'
    }
  });
}

function isAuthorized(request: Request, password?: string): boolean {
  if (!password) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    const split = decoded.indexOf(':');
    if (split < 0) return false;
    const user = decoded.slice(0, split);
    const pass = decoded.slice(split + 1);
    return user === BASIC_USER && pass === password;
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env.O_IDLE_ACCESS_PASSWORD)) return unauthorized();

    const container = getContainer(env.O_STEAM_IDLE, 'primary');
    if (new URL(request.url).pathname.startsWith('/api/cloud/')) return new Response('Not found', {status: 404});
    const response = await container.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('Cache-Control', headers.get('Cache-Control') || 'no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
