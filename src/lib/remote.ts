/** Types mirrored from the `blackwell-remote` crate (camelCase on the wire). */

export type RemoteStatus = {
  bind: string;
  publicUrl: string | null;
  gatewayError: string | null;
  gatewayRunning?: boolean;
  deviceCount: number;
  onlineCount: number;
  activeSessions: number;
  protocolVersion: number;
  serverVersion: string;
};

export type RemoteDevice = {
  id: string;
  name: string;
  customName: string | null;
  online: boolean;
  os: string | null;
  user: string | null;
  integrity: string | null;
  clientVersion: string | null;
  piVersion: string | null;
  pairedAt: number;
  lastSeen: number;
  revoked: boolean;
  sessionState: string;
  sessionProfile: string | null;
};

export type RemotePairing = {
  code: string;
  expiresAt: number;
  publicUrl: string | null;
  command: string;
};

export type RemoteHealth = {
  ok: boolean;
  url: string | null;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
};

export type RemoteInvite = {
  id: string;
  owner: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revoked: boolean;
  state: "unused" | "used" | "revoked" | "expired";
};

export type RemoteCreatedInvite = {
  token: string;
  invite: RemoteInvite;
};

export type RemoteModelRoute = {
  id: string;
  label: string;
  model: string;
  contextWindow: number;
  vision: boolean;
};

export type RemoteSessionOpen = {
  profile: string;
  routes: RemoteModelRoute[];
  cols: number;
  rows: number;
};

export type RemoteTerminateResult = {
  sent: boolean;
  pending: boolean;
};

export type RemoteEvent =
  | { type: "device_updated"; device: RemoteDevice }
  | { type: "device_connected"; deviceId: string; name: string }
  | { type: "device_disconnected"; deviceId: string }
  | { type: "device_removed"; deviceId: string }
  | {
      type: "session_ready";
      deviceId: string;
      pid: number | null;
      piVersion: string | null;
      integrity: string | null;
    }
  | { type: "session_data"; deviceId: string; data: string }
  | { type: "session_exit"; deviceId: string; code: number | null };
