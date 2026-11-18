/**
 * A sign-in to another service's MCP server (Notion, Supabase, Linear, …), kept for the gateway.
 *
 * MCP servers that follow the MCP authorization spec say where to sign in and let a client register itself, so
 * nothing has to be created by hand at the service. The console runs the sign-in (admin/logins.ts); what comes
 * back is kept here, one file per server under <data dir>/mcp-logins/, and the gateway asks this module for a
 * token on every request.
 */
import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { freshToken, signInFile, type SignInFile } from './signin_store.js';

export interface UpstreamLogin {
  /** The MCP server this sign-in is for. A sign-in is never sent anywhere else. */
  url: string;
  /** The authorization server the MCP server named, and what it said about itself (where tokens are renewed). */
  issuer: string;
  metadata?: AuthorizationServerMetadata;
  /** The resource the tokens are asked for (RFC 8707), as the server wrote it. */
  resource?: string;
  /** This installation's registration at the authorization server, and the address it was registered for. */
  client: OAuthClientInformationMixed;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  /** When the access token stops working (ms since 1970), if the server said. */
  expiresAt?: number;
}

/** Names are permission groups: lowercase letters, digits and dashes. Also what keeps a name inside the folder. */
export const UPSTREAM_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function file(name: string): SignInFile<UpstreamLogin> {
  if (!UPSTREAM_NAME.test(name)) throw new Error(`"${name}" is not a name for an MCP server (lowercase letters, digits and dashes).`);
  return signInFile<UpstreamLogin>(`mcp-logins/${name}.json`);
}

export const readUpstreamLogin = (name: string): UpstreamLogin | null => file(name).read();
export const writeUpstreamLogin = (name: string, login: UpstreamLogin): void => file(name).write(login);
export const forgetUpstreamLogin = (name: string): void => file(name).forget();

/** Is there a sign-in for this server, made for this address? */
export function upstreamSignedIn(name: string, url: string): boolean {
  const l = readUpstreamLogin(name);
  return !!l?.accessToken && l.url === url;
}

/** What a token answer adds to the saved sign-in. A refresh token that was not replaced is kept. */
export function withTokens(login: UpstreamLogin, t: OAuthTokens): UpstreamLogin {
  return {
    ...login,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? login.refreshToken,
    expiresAt: typeof t.expires_in === 'number' ? Date.now() + t.expires_in * 1000 : undefined,
  };
}

/**
 * The token to call the server with. `url` is where it is about to be sent: a sign-in made for another address
 * is not used. `rejected` is a token the server has just refused; it is renewed even if its time is not up.
 */
export function upstreamToken(name: string, url: string, rejected?: string): Promise<string> {
  const gone = `[${name}] the sign-in is no longer valid. Open the console (Apps) and sign in again.`;
  const saved = readUpstreamLogin(name);
  if (!saved) return Promise.reject(new Error(`[${name}] not signed in. Open the console (Apps) and sign in.`));
  if (saved.url !== url) return Promise.reject(new Error(`[${name}] the sign-in was made for ${saved.url}, not for this address. Sign in again from the console (Apps).`));
  return freshToken<UpstreamLogin>({
    file: file(name),
    lock: `mcp-login-${name}`,
    token: (l) => (l.accessToken ? { value: l.accessToken, expiresAt: l.expiresAt } : null),
    renew: async (l) => {
      if (!l.refreshToken) return null;
      const t = await refreshAuthorization(l.issuer, { metadata: l.metadata, clientInformation: l.client, refreshToken: l.refreshToken, resource: l.resource });
      return withTokens(l, t);
    },
    gone,
    rejected,
  });
}
