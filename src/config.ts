import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface StoredAuth {
  auth_token: string;
  username?: string;
  perms?: string;
}

/**
 * Waar het auth token wordt bewaard. Bewust NIET in de projectmap:
 * dan kan de repo veilig in git en overleeft het token een herinstall.
 */
export function authFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'rtm-mcp', 'auth.json');
}

export function readStoredAuth(): StoredAuth | null {
  const p = authFilePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StoredAuth;
  } catch {
    return null;
  }
}

export function writeStoredAuth(auth: StoredAuth): string {
  const p = authFilePath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(auth, null, 2), { mode: 0o600 });
  return p;
}

export interface Credentials {
  apiKey: string;
  sharedSecret: string;
  authToken?: string;
}

export function loadCredentials(requireToken: boolean): Credentials {
  const apiKey = process.env.RTM_API_KEY?.trim();
  const sharedSecret = process.env.RTM_SHARED_SECRET?.trim();

  if (!apiKey || !sharedSecret) {
    throw new Error(
      'RTM_API_KEY en RTM_SHARED_SECRET moeten gezet zijn (env of via de MCP-config).'
    );
  }

  const authToken = process.env.RTM_AUTH_TOKEN?.trim() || readStoredAuth()?.auth_token;

  if (requireToken && !authToken) {
    throw new Error(
      `Geen auth token gevonden. Draai eerst: npm run auth  (token komt in ${authFilePath()})`
    );
  }

  return { apiKey, sharedSecret, authToken };
}
