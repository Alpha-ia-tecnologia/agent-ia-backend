import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

const RPC_TIMEOUT_MS = 20_000;

export interface ConnectorFolder {
  path: string;
  readOnly: boolean;
}

export type ConnectorOp = 'list' | 'read' | 'search' | 'write';

interface Entry {
  connectorId: string;
  name: string;
  socket: WebSocket;
  folders: ConnectorFolder[];
}

export interface OnlineDevice {
  connectorId: string;
  name: string;
  folders: ConnectorFolder[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Mantém os túneis WS dos conectores locais (N dispositivos por tenant —
 * ex.: o desktop do dono + o notebook de um funcionário) e faz RPC
 * request/response sobre eles com correlationId. In-memory: v1 assume
 * réplica única da api.
 */
@Injectable()
export class ConnectorRegistryService {
  private readonly logger = new Logger(ConnectorRegistryService.name);
  // companyId -> connectorId -> entrada ativa
  private readonly byCompany = new Map<string, Map<string, Entry>>();
  private readonly pending = new Map<string, PendingCall>();

  register(
    companyId: string,
    connectorId: string,
    name: string,
    socket: WebSocket,
  ) {
    let devices = this.byCompany.get(companyId);
    if (!devices) {
      devices = new Map();
      this.byCompany.set(companyId, devices);
    }
    const existing = devices.get(connectorId);
    if (existing && existing.socket !== socket) {
      // reconexão do MESMO dispositivo substitui a anterior; outros
      // dispositivos do tenant não são afetados.
      this.logger.warn(
        `conector ${connectorId} reconectado (tenant ${companyId})`,
      );
      existing.socket.close(4001, 'substituído por nova conexão');
    }
    devices.set(connectorId, {
      connectorId,
      name,
      socket,
      folders: existing?.folders ?? [],
    });
  }

  unregister(companyId: string, connectorId: string, socket: WebSocket) {
    const devices = this.byCompany.get(companyId);
    const entry = devices?.get(connectorId);
    if (devices && entry && entry.socket === socket) {
      devices.delete(connectorId);
      if (devices.size === 0) this.byCompany.delete(companyId);
    }
  }

  disconnect(connectorId: string) {
    for (const [companyId, devices] of this.byCompany) {
      const entry = devices.get(connectorId);
      if (entry) {
        entry.socket.close(4003, 'conector revogado');
        devices.delete(connectorId);
        if (devices.size === 0) this.byCompany.delete(companyId);
      }
    }
  }

  isOnline(companyId: string): boolean {
    return (this.byCompany.get(companyId)?.size ?? 0) > 0;
  }

  isDeviceOnline(companyId: string, connectorId: string): boolean {
    return this.byCompany.get(companyId)?.has(connectorId) ?? false;
  }

  listOnline(companyId: string): OnlineDevice[] {
    return [...(this.byCompany.get(companyId)?.values() ?? [])].map((e) => ({
      connectorId: e.connectorId,
      name: e.name,
      folders: e.folders,
    }));
  }

  setFolders(
    companyId: string,
    connectorId: string,
    folders: ConnectorFolder[],
  ) {
    const entry = this.byCompany.get(companyId)?.get(connectorId);
    if (entry) entry.folders = folders;
  }

  /**
   * Resolve o dispositivo alvo: por id ou nome (case-insensitive); sem
   * referência, só resolve se houver exatamente um online.
   */
  resolveDevice(companyId: string, ref?: string): Entry | { erro: string } {
    const devices = [...(this.byCompany.get(companyId)?.values() ?? [])];
    if (devices.length === 0) return { erro: 'offline' };
    if (ref) {
      const lower = ref.toLowerCase();
      const match = devices.find(
        (d) => d.connectorId === ref || d.name.toLowerCase() === lower,
      );
      if (!match) {
        return {
          erro: `Dispositivo "${ref}" não está conectado. Disponíveis: ${devices
            .map((d) => d.name)
            .join(', ')}`,
        };
      }
      return match;
    }
    if (devices.length === 1) return devices[0];
    return {
      erro: `Há ${devices.length} computadores conectados — informe o "dispositivo": ${devices
        .map((d) => d.name)
        .join(', ')}`,
    };
  }

  /** RPC pelo túnel; rejeita se offline ou sem resposta em `timeoutMs`. */
  call<T>(
    companyId: string,
    op: ConnectorOp,
    params: Record<string, unknown>,
    deviceRef?: string,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<T> {
    const target = this.resolveDevice(companyId, deviceRef);
    if ('erro' in target) {
      return Promise.reject(
        new Error(target.erro === 'offline' ? 'conector offline' : target.erro),
      );
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('o conector local não respondeu a tempo'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve,
        reject,
        timer,
      });
      target.socket.send(
        JSON.stringify({ type: 'rpc_request', id, op, params }),
        (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        },
      );
    });
  }

  handleRpcResponse(msg: {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }) {
    const call = this.pending.get(msg.id);
    if (!call) return;
    this.pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.ok) call.resolve(msg.result);
    else call.reject(new Error(msg.error ?? 'erro no conector local'));
  }
}
