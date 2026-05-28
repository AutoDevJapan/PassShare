/**
 * @param {object} input
 * @param {object} input.user
 * @param {{ sessionToken: string, expiresAt: string }} input.session
 * @param {{ accessToken: string, expiresIn: number, expiresAt: string }} input.connectToken
 */
export function toMobileAuthResponse({ user, session, connectToken }) {
  return {
    user: {
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
    },
    refreshToken: session.sessionToken,
    sessionExpiresAt: session.expiresAt,
    connectAccessToken: connectToken.accessToken,
    connectExpiresIn: connectToken.expiresIn,
    connectExpiresAt: connectToken.expiresAt,
  };
}
