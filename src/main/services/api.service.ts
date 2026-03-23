import { StoreService } from './store.service';
import { PrintJob, PrintConfig, Workspace } from '../../shared/types';

/**
 * HTTP client for the Hou.la API.
 * Uses the stored access token (JWT) for user-level endpoints
 * and API keys for workspace-level print endpoints.
 */
export class ApiService {
  constructor(private store: StoreService) {}

  // ═══════════════════════════════════════════════════════
  // User-level endpoints (JWT auth)
  // ═══════════════════════════════════════════════════════

  async getWorkspaces(): Promise<Workspace[]> {
    const res = await this.fetchWithAuth('GET', '/api/workspaces');
    return res.data || res;
  }

  async createApiKey(workspaceId: string): Promise<{ key: string; id: string }> {
    return this.fetchWithAuth('POST', '/api/manager/api-keys', {
      name: 'Hou.la Print',
      workspaceId,
    });
  }

  // ═══════════════════════════════════════════════════════
  // Print endpoints (API Key auth)
  // ═══════════════════════════════════════════════════════

  async getPrintConfig(apiKey: string): Promise<PrintConfig> {
    return this.fetchWithApiKey('GET', '/api/print/config', apiKey);
  }

  async getPendingJobs(apiKey: string): Promise<PrintJob[]> {
    return this.fetchWithApiKey('GET', '/api/print/jobs?status=pending', apiKey);
  }

  async ackJob(apiKey: string, jobId: string, status: 'printed' | 'failed', error?: string): Promise<void> {
    await this.fetchWithApiKey('POST', `/api/print/jobs/${encodeURIComponent(jobId)}/ack`, apiKey, {
      status,
      ...(error ? { error } : {}),
    });
  }

  async getLabelData(apiKey: string, jobId: string): Promise<string> {
    const res = await this.fetchWithApiKey('GET', `/api/print/jobs/${encodeURIComponent(jobId)}/label`, apiKey);
    return typeof res === 'string' ? res : res.labelData || res.data;
  }

  // ═══════════════════════════════════════════════════════
  // OAuth token exchange
  // ═══════════════════════════════════════════════════════

  async exchangeOAuthCode(code: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken: string }> {
    const baseUrl = this.store.getApiUrl();
    const res = await fetch(`${baseUrl}/auth/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: 'houla-print-desktop',
        redirect_uri: 'houla-print://callback',
      }),
    });
    if (!res.ok) {
      throw new Error(`OAuth token exchange failed: ${res.status}`);
    }
    return res.json() as Promise<{ accessToken: string; refreshToken: string }>;
  }

  async refreshAccessToken(): Promise<string> {
    const refreshToken = this.store.getRefreshToken();
    if (!refreshToken) throw new Error('No refresh token');

    const baseUrl = this.store.getApiUrl();
    const res = await fetch(`${baseUrl}/auth/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'houla-print-desktop',
      }),
    });
    if (!res.ok) {
      this.store.clearAuth();
      throw new Error('Refresh token expired');
    }
    const data = await res.json() as { accessToken: string; refreshToken?: string };
    this.store.setAccessToken(data.accessToken);
    if (data.refreshToken) {
      this.store.setRefreshToken(data.refreshToken);
    }
    return data.accessToken;
  }

  // ═══════════════════════════════════════════════════════
  // Internal HTTP helpers
  // ═══════════════════════════════════════════════════════

  private async fetchWithAuth(method: string, path: string, body?: unknown): Promise<any> {
    const baseUrl = this.store.getApiUrl();
    let token = this.store.getAccessToken();

    let res = await this.doFetch(method, `${baseUrl}${path}`, {
      Authorization: `Bearer ${token}`,
    }, body);

    // Auto-refresh on 401
    if (res.status === 401) {
      token = await this.refreshAccessToken();
      res = await this.doFetch(method, `${baseUrl}${path}`, {
        Authorization: `Bearer ${token}`,
      }, body);
    }

    if (!res.ok) {
      throw new Error(`API ${method} ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  private async fetchWithApiKey(method: string, path: string, apiKey: string, body?: unknown): Promise<any> {
    const baseUrl = this.store.getApiUrl();
    const res = await this.doFetch(method, `${baseUrl}${path}`, {
      'X-API-Key': apiKey,
    }, body);

    if (!res.ok) {
      throw new Error(`API ${method} ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  private async doFetch(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    return fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HoulaPrint/1.0',
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
}
