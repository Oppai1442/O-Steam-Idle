import { Container, getContainer } from '@cloudflare/containers';
import { env as workerEnv } from 'cloudflare:workers';

const BASIC_USER = 'o-steam-idle';

interface Env {
  O_IDLE_ACCESS_PASSWORD: string;
  O_IDLE_AUTO_START?: string;
  O_IDLE_DEFAULT_APPIDS?: string;
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
    O_IDLE_DEFAULT_APPIDS: runtimeEnv.O_IDLE_DEFAULT_APPIDS || '',
    STEAM_REFRESH_TOKEN: runtimeEnv.STEAM_REFRESH_TOKEN || ''
  };

  async onActivityExpired() {
    // O-Steam-Idle is a long-lived Steam CM session. Intentionally do not call
    // stop() here. Cloudflare renews the activity timer when this hook returns.
    // This keeps the singleton container alive until a rollout/host restart.
  }

  onStart() {
    console.log('O-Steam-Idle container started');
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
