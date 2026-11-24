// "Sign in with Nabux": NabuAuth OIDC, authorization code + PKCE + client
// secret. Errors never carry the code, the verifier or the token.
export class NabuAuthError extends Error {}

export function createNabuAuth(settings, fetcher = fetch) {
  const enabled = Boolean(settings.clientId && settings.clientSecret);

  return {
    enabled,
    url: settings.url,

    authorizeUrl({ state, challenge, prompt }) {
      const params = new URLSearchParams({
        client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: 'code', scope: settings.scopes,
        state, code_challenge: challenge, code_challenge_method: 'S256', ...(prompt ? { prompt } : {})
      });
      return `${settings.url}/oauth/authorize?${params}`;
    },

    endSessionUrl(returnTo) {
      return `${settings.url}/oauth/logout?${new URLSearchParams({ post_logout_redirect_uri: returnTo })}`;
    },

    async exchange(code, verifier) {
      if (!enabled) throw new NabuAuthError('NabuAuth is not configured');
      let tokenRes;
      try {
        tokenRes = await fetcher(`${settings.url}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: settings.clientId,
            client_secret: settings.clientSecret, redirect_uri: settings.redirectUri, code, code_verifier: verifier }).toString(),
          signal: AbortSignal.timeout(20000)
        });
      } catch { throw new NabuAuthError('NabuAuth could not be reached'); }
      const body = await tokenRes.json().catch(() => ({}));
      const access = String(body?.access_token || '');
      if (!tokenRes.ok || !access) throw new NabuAuthError(`NabuAuth token exchange failed (HTTP ${tokenRes.status})`);
      let profileRes;
      try {
        profileRes = await fetcher(`${settings.url}/api/v1/user`, {
          headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000)
        });
      } catch { throw new NabuAuthError('NabuAuth profile could not be read'); }
      const profile = await profileRes.json().catch(() => null);
      if (!profileRes.ok || !profile || typeof profile !== 'object') throw new NabuAuthError(`NabuAuth profile failed (HTTP ${profileRes.status})`);
      const sub = String(profile.sub || '').trim();
      if (!sub) throw new NabuAuthError('NabuAuth did not return an account id');
      const picture = String(profile.picture || profile.avatar_url || '');
      return {
        sub,
        email: String(profile.email || '').trim(),
        emailVerified: profile.email_verified === true,
        name: String(profile.name || profile.preferred_username || ''),
        picture: picture.startsWith('https://') && picture.length <= 500 ? picture : ''
      };
    }
  };
}
