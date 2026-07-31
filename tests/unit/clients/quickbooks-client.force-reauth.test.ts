/**
 * Behavioral test for QuickbooksClient.forceReauth() (fork overlay).
 *
 * forceReauth() must discard all in-memory token state and run the full
 * interactive OAuth flow, even when the stored refresh token still looks
 * valid — recovery from server-side invalidation that authenticate()'s own
 * freshness checks cannot see. Mock harness mirrors
 * quickbooks-client.auth.test.ts.
 */
import { jest } from '@jest/globals';

// The module under test validates env at import time; set deterministic
// values before importing it.
process.env.QUICKBOOKS_CLIENT_ID = 'test-client-id';
process.env.QUICKBOOKS_CLIENT_SECRET = 'test-client-secret';
process.env.QUICKBOOKS_REFRESH_TOKEN = 'stale-but-plausible-token';
process.env.QUICKBOOKS_REALM_ID = '12345';
process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox';
process.env.QUICKBOOKS_REDIRECT_URI = 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl';

type MockOAuth = {
  cfg: Record<string, unknown>;
  refreshUsingToken: jest.Mock;
  createToken: jest.Mock;
  authorizeUri: jest.Mock;
};
const oauthInstances: MockOAuth[] = [];
const refreshDispatch = jest.fn<(token: string) => Promise<unknown>>();
const createTokenDispatch = jest.fn<(url: string) => Promise<unknown>>();

jest.unstable_mockModule('intuit-oauth', () => {
  class MockOAuthClient {
    static scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
    cfg: Record<string, unknown>;
    refreshUsingToken = jest.fn((token: string) => refreshDispatch(token));
    createToken = jest.fn((url: string) => createTokenDispatch(url));
    authorizeUri = jest.fn(() => 'https://appcenter.intuit.com/connect/oauth2?mock');
    constructor(cfg: Record<string, unknown>) {
      this.cfg = cfg;
      oauthInstances.push(this as unknown as MockOAuth);
    }
  }
  return { default: MockOAuthClient };
});

jest.unstable_mockModule('node-quickbooks', () => ({
  default: class MockQuickBooks {
    constructor(..._args: unknown[]) {}
  },
}));

jest.unstable_mockModule('open', () => ({ default: jest.fn(async () => undefined) }));

let callbackHandler:
  | ((req: { url?: string; method?: string }, res: { writeHead: jest.Mock; end: jest.Mock }) => Promise<void>)
  | undefined;
const fakeServer = {
  listen: jest.fn((_port: unknown, _host: unknown, cb?: () => void) => {
    if (cb) setImmediate(cb);
    return fakeServer;
  }),
  close: jest.fn(),
  on: jest.fn(),
  address: jest.fn(() => ({ address: '::', port: 8000, family: 'IPv6' })),
};
jest.unstable_mockModule('http', () => ({
  default: {
    createServer: jest.fn((handler: typeof callbackHandler) => {
      callbackHandler = handler;
      return fakeServer;
    }),
  },
}));

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
jest.unstable_mockModule('fs', () => ({
  default: {
    readFileSync: jest.fn(() => {
      throw enoent();
    }),
    existsSync: jest.fn(() => false),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    unlinkSync: jest.fn(),
  },
}));

const { quickbooksClient } = await import('../../../src/clients/quickbooks-client');

async function untilCallbackRegistered(timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!callbackHandler) {
    if (Date.now() - start > timeoutMs) throw new Error('OAuth callback handler never registered');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('QuickbooksClient.forceReauth', () => {
  it('discards in-memory tokens and runs the interactive flow, never refreshing the discarded token', async () => {
    createTokenDispatch.mockResolvedValueOnce({
      token: { refresh_token: 'flow-refresh-token', realmId: '12345' },
    });
    refreshDispatch.mockResolvedValueOnce({
      token: { access_token: 'access-1', expires_in: 3600, refresh_token: 'rotated-1' },
    });

    const reauthPromise = quickbooksClient.forceReauth();

    // Simulate the user completing consent: Intuit redirects to the local
    // callback server.
    await untilCallbackRegistered();
    const res = { writeHead: jest.fn(), end: jest.fn() };
    await callbackHandler!({ url: '/callback?code=abc&state=testState', method: 'GET' }, res);

    await reauthPromise;

    // The interactive flow ran (a second OAuthClient with the env-declared
    // registered redirect; localhost only as a no-env fallback) even though
    // the env-supplied refresh token looked usable.
    expect(oauthInstances).toHaveLength(2);
    expect(oauthInstances[1].cfg.redirectUri).toBe(
      process.env.QUICKBOOKS_REDIRECT_URI || 'http://localhost:8000/callback',
    );

    // The discarded token was never sent for refresh; only the flow's fresh
    // refresh token was exchanged.
    expect(refreshDispatch).not.toHaveBeenCalledWith('stale-but-plausible-token');
    expect(refreshDispatch).toHaveBeenCalledWith('flow-refresh-token');
  }, 15000);
});
