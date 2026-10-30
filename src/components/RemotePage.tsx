import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTauriListen } from "../hooks/useTauriListen";
import type {
  RemoteCreatedInvite,
  RemoteDevice,
  RemoteEvent,
  RemoteHealth,
  RemoteHelperBuild,
  RemoteInvite,
  RemoteLinkBuild,
  RemotePairing,
  RemoteSessionOpen,
  RemoteStatus,
  RemoteTerminateResult,
} from "../lib/remote";
import type { RemoteSubTab } from "../lib/appNav";
import TabPageHeader from "./TabPageHeader";
import RemoteTerminalOverlay from "./RemoteTerminalOverlay";

function errorText(error: unknown): string {
  return typeof error === "string" ? error : String(error);
}

function timeAgo(unixSeconds: number): string {
  if (!unixSeconds) return "never";
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function dateTime(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function expiresIn(expiresAt: number, nowMs: number): string {
  const remaining = Math.max(0, expiresAt - Math.floor(nowMs / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function sessionActive(device: RemoteDevice): boolean {
  return device.sessionState === "starting" || device.sessionState === "running";
}

function deviceLabel(device: RemoteDevice): string {
  return device.customName?.trim() || device.name;
}

export default function RemotePage({ subTab }: { subTab: RemoteSubTab }) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [health, setHealth] = useState<RemoteHealth | null>(null);
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [terminal, setTerminal] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [invites, setInvites] = useState<RemoteInvite[]>([]);
  const [inviteOwner, setInviteOwner] = useState("");
  const [inviteTtl, setInviteTtl] = useState(72);
  const [createdInvite, setCreatedInvite] = useState<RemoteCreatedInvite | null>(null);
  const [inviteBusy, setInviteBusy] = useState<"create" | "revoke" | null>(null);
  const [helperBuild, setHelperBuild] = useState<RemoteHelperBuild | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const [helperElapsed, setHelperElapsed] = useState(0);
  const [linkBuild, setLinkBuild] = useState<RemoteLinkBuild | null>(null);
  const [linkBuildBusy, setLinkBuildBusy] = useState<"dev" | "rel" | null>(null);
  const [linkBuildElapsed, setLinkBuildElapsed] = useState(0);
  const [editingName, setEditingName] = useState<{ id: string; value: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        invoke<RemoteStatus>("remote_status"),
        invoke<RemoteDevice[]>("remote_devices_list"),
      ]);
      setStatus(nextStatus);
      setDevices(nextDevices);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const next = await invoke<RemoteHealth>("remote_health");
      setHealth(next);
    } catch (e) {
      setHealth({
        ok: false,
        url: null,
        status: null,
        latencyMs: null,
        error: errorText(e),
      });
    }
  }, []);

  const loadInvites = useCallback(async () => {
    try {
      setInvites(await invoke<RemoteInvite[]>("remote_invites_list"));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    void checkHealth();
    void loadInvites();
    const statusTimer = window.setInterval(() => {
      void load();
    }, 15_000);
    const healthTimer = window.setInterval(() => {
      void checkHealth();
    }, 30_000);
    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(healthTimer);
    };
  }, [load, checkHealth, loadInvites]);

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  useTauriListen<RemoteEvent>(
    "remote-event",
    (event) => {
      if (event.type === "session_data") return;
      if (event.type === "device_removed" && terminal?.id === event.deviceId) {
        setTerminal(null);
      }
      void load();
    },
    [load, terminal?.id],
  );

  const gatewayControlReady = typeof status?.gatewayRunning === "boolean";
  const gatewayRunning = status?.gatewayRunning ?? true;

  const toggleGateway = useCallback(async () => {
    if (!status || !gatewayControlReady) return;
    setError(null);
    setNotice(null);
    setBusy("gateway");
    try {
      await invoke(gatewayRunning ? "remote_gateway_stop" : "remote_gateway_start");
      await load();
      await checkHealth();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [status, gatewayControlReady, gatewayRunning, load, checkHealth]);

  const pairDevice = useCallback(async () => {
    setError(null);
    setBusy("pair");
    try {
      const next = await invoke<RemotePairing>("remote_pairing_create");
      setPairing(next);
      setNowMs(Date.now());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard");
      window.setTimeout(() => setNotice(null), 1800);
    } catch {
      setError("Clipboard unavailable; select the text and copy it manually.");
    }
  }, []);

  const createInvite = useCallback(async () => {
    setError(null);
    setNotice(null);
    setInviteBusy("create");
    try {
      const created = await invoke<RemoteCreatedInvite>("remote_invite_create", {
        owner: inviteOwner.trim() || null,
        ttlHours: inviteTtl,
      });
      setCreatedInvite(created);
      setNotice("Invite created. Copy it now; the token is shown once.");
      await loadInvites();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setInviteBusy(null);
    }
  }, [inviteOwner, inviteTtl, loadInvites]);

  const revokeInvite = useCallback(
    async (id: string) => {
      setError(null);
      setNotice(null);
      setInviteBusy("revoke");
      try {
        const revoked = await invoke<boolean>("remote_invite_revoke", { id });
        if (!revoked) setError(`Invite not found: ${id}`);
        if (createdInvite?.invite.id === id) setCreatedInvite(null);
        await loadInvites();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setInviteBusy(null);
      }
    },
    [createdInvite, loadInvites],
  );

  const buildHelper = useCallback(async () => {
    if (!createdInvite) return;
    setError(null);
    setNotice(null);
    setHelperBuild(null);
    setHelperBusy(true);
    setHelperElapsed(0);
    const startedAt = Date.now();
    try {
      const built = await invoke<RemoteHelperBuild>("remote_helper_build", {
        invite: createdInvite.token,
        owner: createdInvite.invite.owner,
      });
      setHelperBuild(built);
      setNotice("Helper .exe built. It is in your Downloads folder.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setHelperElapsed(Math.round((Date.now() - startedAt) / 1000));
      setHelperBusy(false);
    }
  }, [createdInvite]);

  useEffect(() => {
    if (!helperBusy) return;
    const timer = window.setInterval(() => {
      setHelperElapsed((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [helperBusy]);

  useEffect(() => {
    if (subTab !== "status") return;
    const timer = window.setInterval(() => {
      void loadInvites();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [subTab, loadInvites]);

  const buildLink = useCallback(async (profile: "dev" | "rel") => {
    setError(null);
    setNotice(null);
    setLinkBuild(null);
    setLinkBuildBusy(profile);
    setLinkBuildElapsed(0);
    try {
      const built = await invoke<RemoteLinkBuild>("remote_link_build", { profile });
      setLinkBuild(built);
      setNotice(`${profile.toUpperCase()} link built.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLinkBuildBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!linkBuildBusy) return;
    const timer = window.setInterval(() => {
      setLinkBuildElapsed((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [linkBuildBusy]);

  const startSession = useCallback(async (device: RemoteDevice) => {
    setError(null);
    setNotice(null);
    setBusy(device.id);
    try {
      await invoke<RemoteSessionOpen>("remote_session_start", {
        deviceId: device.id,
        cols: 120,
        rows: 32,
      });
      setTerminal({ id: device.id, name: deviceLabel(device) });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const terminate = useCallback(async (device: RemoteDevice) => {
    setError(null);
    setNotice(null);
    setBusy(device.id);
    try {
      const result = await invoke<RemoteTerminateResult>("remote_session_terminate", {
        deviceId: device.id,
      });
      if (result.pending) {
        setNotice("Terminate queued; it will be delivered when the device reconnects.");
      }
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const renameDevice = useCallback(async (device: RemoteDevice) => {
    if (editingName?.id !== device.id) return;
    setError(null);
    setNotice(null);
    setBusy(device.id);
    try {
      await invoke("remote_device_rename", {
        deviceId: device.id,
        customName: editingName.value.trim() || null,
      });
      setEditingName(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [editingName, load]);

  const revoke = useCallback(async (device: RemoteDevice) => {
    if (!window.confirm(`Revoke ${deviceLabel(device)}? The device must be paired again.`)) return;
    setError(null);
    setBusy(device.id);
    try {
      await invoke("remote_device_revoke", { deviceId: device.id });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const healthLabel = useMemo(() => {
    if (!health) return { label: "CHECKING…", tone: "wait" };
    if (health.ok) return { label: "PUBLIC OK", tone: "ok" };
    if (health.url) return { label: "DEGRADED", tone: "bad" };
    return { label: "NOT CONFIGURED", tone: "wait" };
  }, [health]);

  return (
    <div className="h-full flex flex-col overflow-hidden" data-remote-page>
      <TabPageHeader title="REMOTE" />
      <div className="remote-panel">
        <div className="remote-panel__head">
          <p className="type-label font-mono remote-muted">
            {subTab === "status"
              ? "Outbound-only Windows link. Gateway state, public endpoint and pairing."
              : "Paired devices, live pi-maintenance sessions and terminal access."}
          </p>
          <div className="remote-head-actions">
            {subTab === "status" && (
              <button type="button" className="remote-action" onClick={() => void checkHealth()}>
                CHECK TUNNEL
              </button>
            )}
            <button
              type="button"
              className="remote-action remote-action--accent"
              disabled={busy === "pair"}
              onClick={() => void pairDevice()}
            >
              {busy === "pair" ? "CREATING…" : "PAIR DEVICE"}
            </button>
          </div>
        </div>

        {error && <div className="remote-banner remote-banner--bad">{error}</div>}
        {notice && <div className="remote-banner remote-banner--ok">{notice}</div>}

        {subTab === "status" ? (
          <>
            <div className="remote-status-grid">
        <div className="remote-card">
          <span className="type-micro font-mono remote-card__label">PUBLIC ENDPOINT</span>
          <span className={`remote-state is-${healthLabel.tone}`}>{healthLabel.label}</span>
          <span className="type-tiny font-mono remote-card__detail remote-ellipsis" title={status?.publicUrl ?? ""}>
            {status?.publicUrl ?? "not configured"}
          </span>
          <span className="type-tiny font-mono remote-card__detail">
            {health?.latencyMs != null ? `${health.latencyMs} ms` : health?.error ?? "waiting for check"}
          </span>
        </div>
        <div className="remote-card">
          <span className="type-micro font-mono remote-card__label">GATEWAY</span>
          <span className={`remote-state ${gatewayRunning ? (status?.gatewayError ? "is-bad" : "is-ok") : "is-bad"}`}>
            {!status
              ? "CHECKING…"
              : !gatewayControlReady
                ? status.gatewayError
                  ? "ERROR"
                  : "LISTENING"
                : !gatewayRunning
                  ? "STOPPED"
                  : status.gatewayError
                    ? "ERROR"
                    : "LISTENING"}
          </span>
          <span className="type-tiny font-mono remote-card__detail">{status?.bind ?? "—"}</span>
          <span className="type-tiny font-mono remote-card__detail">
            {status ? `protocol ${status.protocolVersion} · v${status.serverVersion}` : "—"}
          </span>
          {gatewayControlReady && (
            <button
              type="button"
              className={`remote-action ${gatewayRunning ? "remote-action--danger" : "remote-action--accent"}`}
              disabled={!status || busy === "gateway"}
              onClick={() => void toggleGateway()}
            >
              {busy === "gateway" ? "…" : gatewayRunning ? "STOP GATEWAY" : "START GATEWAY"}
            </button>
          )}
        </div>
        <div className="remote-card">
          <span className="type-micro font-mono remote-card__label">DEVICES</span>
          <span className="remote-card__value type-xl">{status?.onlineCount ?? 0}<span className="remote-muted"> / {status?.deviceCount ?? 0}</span></span>
          <span className="type-tiny font-mono remote-card__detail">online / paired</span>
        </div>
        <div className="remote-card">
          <span className="type-micro font-mono remote-card__label">SESSIONS</span>
          <span className="remote-card__value type-xl">{status?.activeSessions ?? 0}</span>
          <span className="type-tiny font-mono remote-card__detail">active pi sessions</span>
        </div>
            </div>

            <section className="remote-invites">
              <div className="remote-invites__head">
                <div>
                  <span className="type-micro font-mono remote-card__label">SUPPORT INVITES</span>
                  <p className="type-tiny font-mono remote-muted">
                    One-time helper pairing. The token is shown once and can be revoked.
                  </p>
                </div>
                <span className="remote-invite-count">
                  {invites.filter((invite) => invite.state === "unused").length} UNUSED
                </span>
              </div>

              <div className="remote-invite-form">
                <input
                  className="remote-invite-input"
                  value={inviteOwner}
                  maxLength={80}
                  placeholder="Owner label (e.g. Alex)"
                  onChange={(event) => setInviteOwner(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createInvite();
                  }}
                />
                <select
                  className="remote-invite-select"
                  value={inviteTtl}
                  onChange={(event) => setInviteTtl(Number(event.target.value))}
                >
                  <option value={24}>24 HOURS</option>
                  <option value={72}>72 HOURS</option>
                  <option value={168}>7 DAYS</option>
                </select>
                <button
                  type="button"
                  className="remote-action remote-action--accent"
                  disabled={inviteBusy === "create"}
                  onClick={() => void createInvite()}
                >
                  {inviteBusy === "create" ? "CREATING…" : "CREATE INVITE"}
                </button>
              </div>

              {createdInvite && (
                <div className="remote-invite-token">
                  <div className="remote-invite-token__head">
                    <span className="type-micro font-mono">TOKEN · SHOWN ONCE</span>
                    <button
                      type="button"
                      className="remote-action"
                      onClick={() => void copy(createdInvite.token)}
                    >
                      COPY
                    </button>
                  </div>
                  <code className="remote-invite-token__value">{createdInvite.token}</code>
                  <p className="type-tiny font-mono remote-muted">
                    Single-use for first pairing; restarts reuse the saved device token. Expires{" "}
                    {dateTime(createdInvite.invite.expiresAt)}. Put it in the helper package; do not
                    paste it into chat.
                  </p>
                  <div className="remote-helper-actions">
                    <button
                      type="button"
                      className="remote-action remote-action--accent"
                      disabled={helperBusy}
                      onClick={() => void buildHelper()}
                    >
                      {helperBusy ? "BUILDING HELPER…" : "BUILD HELPER .EXE"}
                    </button>
                    {helperBuild && (
                      <span className="type-tiny font-mono remote-muted">
                        {(helperBuild.sizeBytes / 1024 / 1024).toFixed(1)} MB ·{" "}
                        {helperBuild.path}
                      </span>
                    )}
                  </div>
                  {helperBusy && (
                    <div className="remote-helper-progress">
                      <span className="remote-spinner" aria-hidden />
                      <div className="remote-helper-progress__text">
                        <strong>BUILDING HELPER</strong>
                        <span>
                          Packing the 111 MB Pi payload with NSIS… {helperElapsed}s
                        </span>
                      </div>
                      <div className="remote-progress-track">
                        <span />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="remote-invite-list">
                {invites.length === 0 ? (
                  <p className="type-tiny font-mono remote-muted">
                    No invites yet. Create one instead of reading a short pairing code.
                  </p>
                ) : (
                  invites.map((invite) => (
                    <div key={invite.id} className={`remote-invite-row is-${invite.state}`}>
                      <div className="remote-invite-row__main">
                        <span className="remote-invite-row__owner">
                          {invite.owner?.trim() || "Unlabelled invite"}
                        </span>
                        <span className="type-tiny font-mono remote-muted">{invite.id}</span>
                      </div>
                      <div className="remote-invite-row__meta">
                        <span className={`remote-invite-state is-${invite.state}`}>
                          {invite.state.toUpperCase()}
                        </span>
                        <span className="type-tiny font-mono remote-muted">
                          {invite.state === "used"
                            ? `used ${dateTime(invite.usedAt ?? 0)}`
                            : `expires ${dateTime(invite.expiresAt)}`}
                        </span>
                      </div>
                      {invite.state === "unused" && (
                        <button
                          type="button"
                          className="remote-action remote-action--danger"
                          disabled={inviteBusy === "revoke"}
                          onClick={() => void revokeInvite(invite.id)}
                        >
                          REVOKE
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="remote-invites remote-link-builds">
              <div className="remote-invites__head">
                <div>
                  <span className="type-micro font-mono remote-card__label">LINK BUILDS</span>
                  <p className="type-tiny font-mono remote-muted">
                    Build the device app here instead of opening another terminal. REL is
                    standalone; DEV still needs its Vite server.
                  </p>
                </div>
              </div>
              <div className="remote-invite-form">
                <button
                  type="button"
                  className="remote-action"
                  disabled={linkBuildBusy !== null}
                  onClick={() => void buildLink("dev")}
                >
                  {linkBuildBusy === "dev" ? "BUILDING DEV…" : "BUILD LINK DEV"}
                </button>
                <button
                  type="button"
                  className="remote-action remote-action--accent"
                  disabled={linkBuildBusy !== null}
                  onClick={() => void buildLink("rel")}
                >
                  {linkBuildBusy === "rel" ? "BUILDING REL…" : "BUILD LINK REL"}
                </button>
              </div>
              {linkBuildBusy && (
                <div className="remote-helper-progress">
                  <span className="remote-spinner" aria-hidden />
                  <div className="remote-helper-progress__text">
                    <strong>BUILDING LINK {linkBuildBusy.toUpperCase()}</strong>
                    <span>Cargo + frontend… {linkBuildElapsed}s</span>
                  </div>
                  <div className="remote-progress-track">
                    <span />
                  </div>
                </div>
              )}
              {linkBuild && (
                <div className="remote-link-build-result">
                  <span className="remote-invite-state is-used">{linkBuild.profile.toUpperCase()}</span>
                  <code>APP {linkBuild.app}</code>
                  {linkBuild.cli && <code>CLI {linkBuild.cli}</code>}
                </div>
              )}
            </section>

            {status?.publicUrl == null && (
              <p className="type-tiny font-mono remote-footnote">
                Quick-tunnel setup: run <code>cloudflared tunnel --url http://127.0.0.1:7443 --protocol http2 --edge-ip-version 4</code>,
                then write the printed URL to <code>config/remote/public_url.txt</code> and restart Blackwell Ops.
              </p>
            )}
          </>
        ) : (
          <div className="remote-devices">
        <div className="remote-devices__head">
          <span className="type-micro font-mono remote-card__label">PAIRED DEVICES</span>
          <span className="type-tiny font-mono remote-muted">
            {devices.length === 0 ? "No devices yet" : `${devices.length} device${devices.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {devices.length === 0 ? (
          <div className="remote-empty">
            <p className="type-body font-mono remote-muted">NO REMOTE DEVICE PAIRED</p>
            <p className="type-label font-mono remote-muted">
              Run PAIR DEVICE, then start the portable client on the target with the displayed code.
            </p>
          </div>
        ) : (
          <div className="remote-device-list">
            {devices.map((device) => {
              const active = sessionActive(device);
              const rowBusy = busy === device.id;
              return (
                <div key={device.id} className={`remote-device-row ${device.online ? "is-online" : "is-offline"}`}>
                  <div className="remote-device-main">
                    <div className="remote-device-name-row">
                      <span className={`remote-dot ${device.online ? "is-online" : "is-offline"}`} aria-hidden />
                      {editingName?.id === device.id ? (
                        <span className="remote-device-rename">
                          <input
                            autoFocus
                            className="remote-rename-input"
                            value={editingName.value}
                            placeholder={device.name}
                            maxLength={80}
                            onChange={(e) => setEditingName({ id: device.id, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void renameDevice(device);
                              if (e.key === "Escape") setEditingName(null);
                            }}
                          />
                          <button
                            type="button"
                            className="remote-action remote-action--accent"
                            disabled={rowBusy}
                            onClick={() => void renameDevice(device)}
                          >
                            SAVE
                          </button>
                          <button type="button" className="remote-action" onClick={() => setEditingName(null)}>
                            CANCEL
                          </button>
                        </span>
                      ) : (
                        <>
                          <span className="type-body font-mono remote-device-name">{deviceLabel(device)}</span>
                          <button
                            type="button"
                            className="remote-action"
                            onClick={() => setEditingName({ id: device.id, value: device.customName ?? "" })}
                          >
                            RENAME
                          </button>
                        </>
                      )}
                      <span className={`remote-state ${device.online ? "is-ok" : "is-bad"}`}>
                        {device.online ? "ONLINE" : "OFFLINE"}
                      </span>
                      {active && <span className={`remote-state ${device.sessionState === "running" ? "is-live" : "is-wait"}`}>{device.sessionState.toUpperCase()}</span>}
                    </div>
                    <div className="type-tiny font-mono remote-device-meta">
                      {device.customName && <span>system {device.name}</span>}
                      <span>{device.os ?? "unknown OS"}</span>
                      <span>{device.user ?? "unknown user"}</span>
                      <span>{device.integrity ? `${device.integrity} integrity` : "integrity ?"}</span>
                      <span>pi {device.piVersion ?? "?"}</span>
                      <span>seen {timeAgo(device.lastSeen)}</span>
                    </div>
                  </div>
                  <div className="remote-device-actions">
                    {active ? (
                      <>
                        <button
                          type="button"
                          className="remote-action remote-action--accent"
                          onClick={() => setTerminal({ id: device.id, name: deviceLabel(device) })}
                        >
                          OPEN TERMINAL
                        </button>
                        <button
                          type="button"
                          className="remote-action remote-action--danger"
                          disabled={rowBusy}
                          onClick={() => void terminate(device)}
                        >
                          {rowBusy ? "…" : "TERMINATE"}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="remote-action remote-action--accent"
                        disabled={!device.online || rowBusy}
                        onClick={() => void startSession(device)}
                      >
                        {rowBusy ? "OPENING…" : "OPEN SESSION"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="remote-action remote-action--danger"
                      disabled={rowBusy}
                      onClick={() => void revoke(device)}
                    >
                      REVOKE
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
          </div>
        )}

        {pairing && (
        <div className="remote-modal-overlay" role="dialog" aria-modal="true" aria-label="Pair remote device">
          <div className="remote-modal">
            <div className="remote-modal__head">
              <div>
                <h3 className="type-body font-mono remote-title">PAIR A DEVICE</h3>
                <p className="type-label font-mono remote-muted">One-time code. Expires in {expiresIn(pairing.expiresAt, nowMs)}.</p>
              </div>
              <button type="button" className="remote-action" onClick={() => setPairing(null)}>
                CLOSE
              </button>
            </div>
            <div className="remote-pair-code">{pairing.code}</div>
            <p className="type-label font-mono remote-muted">
              Start the portable client on the target and enter this code. It exchanges the code for a device token,
              then connects outbound to the gateway.
            </p>
            <pre className="remote-command">{pairing.command}</pre>
            <div className="remote-modal__actions">
              <button type="button" className="remote-action" onClick={() => void copy(pairing.code)}>
                COPY CODE
              </button>
              <button type="button" className="remote-action remote-action--accent" onClick={() => void copy(pairing.command)}>
                COPY COMMAND
              </button>
            </div>
            {pairing.publicUrl == null && (
              <p className="type-tiny font-mono remote-banner remote-banner--warn">
                Public URL is not configured yet. Set config/remote/public_url.txt before using this command.
              </p>
            )}
          </div>
        </div>
      )}

      {terminal && (
        <RemoteTerminalOverlay
          deviceId={terminal.id}
          deviceName={terminal.name}
          onClose={() => setTerminal(null)}
          onRestart={() => {
            const device = devices.find((candidate) => candidate.id === terminal.id);
            if (device) void startSession(device);
          }}
        />
      )}
      </div>
    </div>
  );
}
