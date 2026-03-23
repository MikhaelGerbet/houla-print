import { StoreService } from './store.service';
import { ApiService } from './api.service';
import { WorkspaceState, Workspace, PrintConfig } from '../../shared/types';

/**
 * Manages the list of workspaces the user has access to.
 * Handles API key creation per workspace and enable/disable toggling.
 */
export class WorkspaceService {
  private workspaceStates: Map<string, WorkspaceState> = new Map();

  constructor(
    private store: StoreService,
    private api: ApiService,
  ) {}

  /**
   * Refresh the workspace list from the API and sync with stored keys.
   */
  async refresh(): Promise<void> {
    const remoteWorkspaces = await this.api.getWorkspaces();
    const stored = this.store.getWorkspaces();

    for (const ws of remoteWorkspaces) {
      let apiKey = stored[ws.id]?.apiKey || null;
      const enabled = stored[ws.id]?.enabled ?? false;

      // Auto-create API key if workspace is enabled but has no key
      if (enabled && !apiKey) {
        try {
          const result = await this.api.createApiKey(ws.id);
          apiKey = result.key;
          this.store.setWorkspace(ws.id, { apiKey, enabled, workspaceName: ws.name });
        } catch (err) {
          console.error(`Failed to create API key for workspace ${ws.id}:`, err);
        }
      }

      // Fetch print config if we have an API key
      let config: PrintConfig | null = null;
      if (apiKey) {
        try {
          config = await this.api.getPrintConfig(apiKey);
        } catch {
          // Config not yet created — will be created on first access
        }
      }

      this.workspaceStates.set(ws.id, {
        workspace: ws,
        apiKey: apiKey || '',
        enabled,
        config,
      });
    }

    // Remove stored workspaces that no longer exist remotely
    const remoteIds = new Set(remoteWorkspaces.map(w => w.id));
    for (const storedId of Object.keys(stored)) {
      if (!remoteIds.has(storedId)) {
        this.store.removeWorkspace(storedId);
        this.workspaceStates.delete(storedId);
      }
    }
  }

  /**
   * Enable or disable a workspace for printing.
   */
  async toggle(workspaceId: string, enabled: boolean): Promise<void> {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;

    // Create API key if enabling for the first time
    if (enabled && !state.apiKey) {
      const result = await this.api.createApiKey(workspaceId);
      state.apiKey = result.key;
    }

    state.enabled = enabled;
    this.store.setWorkspace(workspaceId, {
      apiKey: state.apiKey,
      enabled,
      workspaceName: state.workspace.name,
    });
  }

  getAll(): WorkspaceState[] {
    return Array.from(this.workspaceStates.values());
  }

  getActiveWorkspaces(): WorkspaceState[] {
    return this.getAll().filter(ws => ws.enabled && ws.apiKey);
  }

  getApiKey(workspaceId: string): string {
    return this.workspaceStates.get(workspaceId)?.apiKey || '';
  }
}
