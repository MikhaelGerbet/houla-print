import { io, Socket } from 'socket.io-client';
import { StoreService } from './store.service';
import { QueueService } from './queue.service';
import { WorkspaceService } from './workspace.service';
import { WorkspaceState, PrintJob } from '../../shared/types';
import { WS_PATH } from '../../shared/config';

/**
 * Manages Socket.IO connections to the Hou.la API.
 * One connection per active workspace, using API Key auth.
 */
export class SocketService {
  private sockets: Map<string, Socket> = new Map();

  constructor(
    private store: StoreService,
    private queue: QueueService,
    private workspaces: WorkspaceService,
    private onStateChange: () => void,
  ) {}

  /**
   * Connect to all active workspaces.
   */
  connectAll(activeWorkspaces: WorkspaceState[]): void {
    for (const ws of activeWorkspaces) {
      this.connect(ws.workspace.id, ws.apiKey);
    }
  }

  /**
   * Connect to a specific workspace via Socket.IO.
   */
  connect(workspaceId: string, apiKey: string): void {
    if (this.sockets.has(workspaceId)) return;

    const baseUrl = this.store.getApiUrl();
    const socket = io(baseUrl, {
      path: WS_PATH,
      auth: { apiKey },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      console.log(`[WS] Connected to workspace:${workspaceId}`);
      // Subscribe to the workspace room
      socket.emit('subscribe:workspace', { workspaceId });
      this.onStateChange();

      // Fetch any pending jobs that arrived while disconnected
      this.queue.fetchPendingForWorkspace(workspaceId, apiKey).catch(console.error);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WS] Disconnected from workspace:${workspaceId}: ${reason}`);
      this.onStateChange();
    });

    socket.on('print:jobs', (data: { type: 'new' | 'cancelled'; jobs?: PrintJob[]; jobIds?: string[] }) => {
      if (data.type === 'new' && data.jobs) {
        console.log(`[WS] Received ${data.jobs.length} new print jobs for workspace:${workspaceId}`);
        this.queue.enqueueJobs(data.jobs, apiKey);
      } else if (data.type === 'cancelled' && data.jobIds) {
        console.log(`[WS] ${data.jobIds.length} jobs cancelled for workspace:${workspaceId}`);
        this.queue.cancelJobs(data.jobIds);
      }
      this.onStateChange();
    });

    // Config updated from manager dashboard — sync local state
    socket.on('print:config-updated', (data: { config: any }) => {
      console.log(`[WS] Config updated for workspace:${workspaceId}`);
      this.workspaces.applyRemoteConfig(workspaceId, data.config);
      this.onStateChange();
    });

    socket.on('error', (err: string) => {
      console.error(`[WS] Error for workspace:${workspaceId}:`, err);
    });

    this.sockets.set(workspaceId, socket);
  }

  /**
   * Disconnect from a specific workspace.
   */
  disconnect(workspaceId: string): void {
    const socket = this.sockets.get(workspaceId);
    if (socket) {
      socket.emit('unsubscribe:workspace', { workspaceId });
      socket.disconnect();
      this.sockets.delete(workspaceId);
    }
  }

  /**
   * Disconnect all sockets.
   */
  disconnectAll(): void {
    for (const [id] of this.sockets) {
      this.disconnect(id);
    }
  }

  /**
   * Check if at least one socket is connected.
   */
  isConnected(): boolean {
    for (const socket of this.sockets.values()) {
      if (socket.connected) return true;
    }
    return false;
  }
}
