import { shell } from 'electron';
import * as crypto from 'crypto';
import { StoreService } from './store.service';
import { ApiService } from './api.service';
import { APP_PROTOCOL } from '../../shared/config';

/**
 * OAuth 2.0 PKCE authentication flow.
 * Opens the system browser for login, handles the callback via custom protocol.
 */
export class AuthService {
  private codeVerifier: string | null = null;

  constructor(
    private store: StoreService,
    private api: ApiService,
  ) {}

  isAuthenticated(): boolean {
    return !!this.store.getAccessToken();
  }

  /**
   * Initiate OAuth login: open browser to Hou.la auth page with PKCE challenge.
   */
  async login(): Promise<void> {
    // Generate PKCE code verifier + challenge
    this.codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(this.codeVerifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'houla-print-desktop',
      redirect_uri: `${APP_PROTOCOL}://callback`,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'workspaces print api-keys',
    });

    const authUrl = `${this.store.getAppUrl()}/oauth/authorize?${params.toString()}`;
    await shell.openExternal(authUrl);
  }

  /**
   * Handle the OAuth callback URL: houla-print://callback?code=...
   */
  async handleOAuthCallback(url: string): Promise<void> {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    const error = parsed.searchParams.get('error');

    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }

    if (!code || !this.codeVerifier) {
      throw new Error('Missing OAuth code or code verifier');
    }

    const tokens = await this.api.exchangeOAuthCode(code, this.codeVerifier);
    this.codeVerifier = null;

    this.store.setAccessToken(tokens.accessToken);
    this.store.setRefreshToken(tokens.refreshToken);
  }

  logout(): void {
    this.store.clearAuth();
  }

  // ═══════════════════════════════════════════════════════
  // PKCE helpers
  // ═══════════════════════════════════════════════════════

  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  private generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }
}
