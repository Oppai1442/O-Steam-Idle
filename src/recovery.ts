/** Pure Steam reconnect-policy helpers. No session secrets or network calls. */
export function isSteamSessionConflict(err: any): boolean {
  return Number(err?.eresult) === 6 || /LoggedInElsewhere/i.test(String(err?.message || ''));
}
export function isSteamAuthRejection(err: any): boolean {
  // Authentication/session revocation requires fresh user approval; network
  // errors such as EResult 3 (NoConnection) must never block recovery.
  const code = Number(err?.eresult || 0);
  return [5, 15, 18, 65, 85].includes(code)
    || /InvalidPassword|InvalidLoginAuthCode|ExpiredLoginAuthCode|AccountLogonDenied|InvalidRefreshToken|Revoked.*Token/i.test(String(err?.message || ''));
}
export function recoveryBackoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(120000, 5000 * 2 ** Math.min(5, n - 1));
}
