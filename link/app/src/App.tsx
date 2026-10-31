import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Status = {
  mode: string;
  connected: boolean;
  paired: boolean;
  deviceName: string;
  gateway: string;
  version: string;
  homeModels: number;
  homeRoutes: { id: string; label: string; model: string; contextWindow: number; vision: boolean }[];
  cloudModel: string;
  cloudKeyStored: boolean;
  serverVersion: string | null;
  publicUrl: string | null;
  session: boolean;
  error: string | null;
};

type Settings = {
  deviceName: string;
  gatewayUrl: string;
  cloudBaseUrl: string;
  cloudModel: string;
  cloudKeyStored: boolean;
};

type Bootstrap = {
  paired: boolean;
  helper: boolean;
  owner: string | null;
  deviceName: string;
  gateway: string;
  error: string | null;
};

type ServiceStatus = {
  installed: boolean;
  running: boolean;
  pid: number | null;
  childPid: number | null;
  connected: boolean;
  sessionActive: boolean;
  updatedAt: number | null;
  error: string | null;
};

type HelperLink = {
  linked: boolean;
  sessionActive: boolean;
  updatedAt: number | null;
  error: string | null;
};

const DEFAULT_STATUS: Status = {
  mode: "portable",
  connected: false,
  paired: false,
  deviceName: "",
  gateway: "",
  version: "0.1.0",
  homeModels: 0,
  homeRoutes: [],
  cloudModel: "deepseek-flash",
  cloudKeyStored: false,
  serverVersion: null,
  publicUrl: null,
  session: false,
  error: null,
};

const DEFAULT_SETTINGS: Settings = {
  deviceName: "",
  gatewayUrl: "",
  cloudBaseUrl: "https://api.deepseek.com",
  cloudModel: "deepseek-flash",
  cloudKeyStored: false,
};

type View = "home" | "pair" | "settings";

export default function App() {
  const [view, setView] = useState<View>("home");
  const [status, setStatus] = useState<Status>(DEFAULT_STATUS);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [code, setCode] = useState("");
  const [gateway, setGateway] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [serviceLog, setServiceLog] = useState("");
  const lastServiceInstalled = useRef<boolean | null>(null);
  const [helperStopped, setHelperStopped] = useState(false);
  const [helperForgotten, setHelperForgotten] = useState(false);
  const [helperLink, setHelperLink] = useState<HelperLink | null>(null);
  const [provider, setProvider] = useState<"private" | "cloud">("private");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<Status>("link_status"));
    } catch {
      // Browser preview / first wiring slice: keep the offline shell.
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const loaded = await invoke<Settings>("link_settings_get");
      setSettings(loaded);
      setGateway((current) => current || loaded.gatewayUrl);
    } catch {
      setSettings(DEFAULT_SETTINGS);
    }
  }, []);

  const loadService = useCallback(async () => {
    try {
      setService(await invoke<ServiceStatus>("service_status"));
    } catch {
      setService(null);
    }
  }, []);

  useEffect(() => {
    void loadService();
    const timer = window.setInterval(() => void loadService(), 5000);
    return () => window.clearInterval(timer);
  }, [loadService]);

  useEffect(() => {
    if (busy !== "service") {
      setServiceLog("");
      return;
    }
    const load = () => {
      void invoke<string>("service_install_log")
        .then(setServiceLog)
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!service) return;
    const previous = lastServiceInstalled.current;
    lastServiceInstalled.current = service.installed;
    if (previous === true && !service.installed && boot?.paired && !boot.helper) {
      // Service was just removed: return the device to Portable instead of
      // leaving Blackwell with no link.
      void invoke("link_portable_start").catch(() => {});
    }
  }, [service?.installed, boot?.paired, boot?.helper]);

  useEffect(() => {
    void invoke<boolean>("helper_stopped")
      .then(setHelperStopped)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!boot?.helper) return;
    const load = () => {
      void invoke<HelperLink>("helper_link_status")
        .then(setHelperLink)
        .catch(() => {});
    };
    void load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [boot?.helper]);

  const stopHelper = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await invoke("helper_stop");
      setHelperStopped(true);
      setHelperLink(null);
      setNotice("Remote access stopped.");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, []);

  const reconnectHelper = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await invoke("helper_reconnect");
      setHelperStopped(false);
      setNotice("Reconnecting…");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, []);

  const closeHelper = useCallback(() => {
    void invoke("helper_close").catch(() => {});
  }, []);

  const forgetHelper = useCallback(async () => {
    if (
      !window.confirm(
        "Forget this device? Remote access ends and this PC will need a new helper package to reconnect.",
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await invoke("helper_forget");
      setHelperStopped(true);
      setHelperForgotten(true);
      setHelperLink(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadSettings();
    void invoke<Bootstrap>("invite_bootstrap")
      .then(setBoot)
      .catch((e) =>
        setBoot({
          paired: false,
          helper: false,
          owner: null,
          deviceName: "",
          gateway: "",
          error: typeof e === "string" ? e : String(e),
        }),
      );
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [refresh, loadSettings]);

  const hide = useCallback(() => {
    void invoke("link_hide").catch(() => {});
  }, []);

  const openPair = useCallback(() => {
    setGateway(settings.gatewayUrl || status.gateway || "");
    setError(null);
    setNotice(null);
    setView("pair");
  }, [settings.gatewayUrl, status.gateway]);

  const pair = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy("pair");
    try {
      const next = await invoke<Status>("link_pair", {
        code: code.trim(),
        server: gateway.trim(),
      });
      setStatus(next);
      setSettings((current) => ({ ...current, gatewayUrl: gateway.trim() }));
      setNotice(next.connected ? "Paired and online." : "Paired. The gateway is not reachable yet.");
      setCode("");
      setView("home");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [code, gateway, refresh]);

  const startAssistant = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy("assistant");
    try {
      await invoke("assistant_open", { provider });
      setNotice("Assistant terminal opened.");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [provider]);

  const saveSettings = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy("settings");
    try {
      await invoke("link_settings_set", { settings });
      setNotice("Saved.");
      await loadSettings();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [settings, loadSettings]);

  const storeCloudKey = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy("cloudkey");
    try {
      await invoke("cloud_key_set", { key: apiKey.trim() });
      setApiKey("");
      setNotice("Cloud key stored in Windows Credential Manager.");
      await loadSettings();
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [apiKey, loadSettings, refresh]);

  const removeCloudKey = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy("cloudkey");
    try {
      await invoke("cloud_key_clear");
      setNotice("Cloud key removed.");
      await loadSettings();
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [loadSettings, refresh]);

  const installService = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy("service");
    try {
      await invoke("service_install");
      setNotice("UAC prompt opened. Finish the elevated install, then status refreshes.");
      window.setTimeout(() => {
        void loadService();
        setNotice(null);
      }, 12000);
      window.setTimeout(() => void loadService(), 4000);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [loadService]);

  const uninstallService = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy("service");
    try {
      await invoke("service_uninstall");
      setNotice("UAC prompt opened for service removal.");
      window.setTimeout(() => {
        void loadService();
        setNotice(null);
      }, 12000);
      window.setTimeout(() => void loadService(), 4000);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [loadService]);

  if (!boot) {
    return <div className="boot-screen">Preparing secure link…</div>;
  }
  if (boot.helper) {
    return (
      <HelperScreen
        boot={boot}
        status={status}
        stopped={helperStopped}
        forgotten={helperForgotten}
        link={helperLink}
        onStop={() => void stopHelper()}
        onReconnect={() => void reconnectHelper()}
        onForget={() => void forgetHelper()}
        onClose={closeHelper}
      />
    );
  }

  return (
    <div className="app">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">O</span>
          <span className="brand-name">OYM</span>
          <span className="mode-chip">
            {service?.installed ? "INTEGRATED" : status.mode.toUpperCase()}
          </span>
        </div>
        <button className="icon-button" title="Hide" onClick={hide}>
          —
        </button>
      </header>

      <main className="content">
        {view === "home" && (
          <>
            <section className="card">
              <div className="card-head">
                <span className="label">CONNECTION</span>
                <span className={`state ${status.connected ? "is-on" : "is-off"}`}>
                  <span className="dot" />
                  {status.connected ? "ONLINE" : status.paired ? "PAIRED · OFFLINE" : "OFFLINE"}
                </span>
              </div>
              <dl className="kv">
                <dt>Gateway</dt>
                <dd className={status.gateway || gateway ? "" : "muted"}>
                  {status.gateway || gateway || "not paired"}
                </dd>
                <dt>Device</dt>
                <dd className={status.deviceName ? "" : "muted"}>{status.deviceName || "—"}</dd>
              </dl>
              {status.error && <p className="copy">{status.error}</p>}
              <button className="button" onClick={openPair}>
                {status.paired || status.gateway ? "REPAIR DEVICE" : "PAIR DEVICE"}
              </button>
            </section>

            <section className="card">
              <div className="card-head">
                <span className="label">ASSISTANT</span>
                <div className="segmented">
                  <button
                    className={`segment ${provider === "private" ? "is-selected" : ""}`}
                    onClick={() => setProvider("private")}
                  >
                    PRIVATE
                  </button>
                  <button
                    className={`segment ${provider === "cloud" ? "is-selected" : ""}`}
                    onClick={() => setProvider("cloud")}
                  >
                    CLOUD
                  </button>
                </div>
              </div>

              {provider === "private" ? (
                <>
                  <p className="copy">
                    Blackwell engines on this machine. The engines keep running; switching tabs
                    only changes where the assistant sends work.
                  </p>
                  {status.homeRoutes.length > 0 ? (
                    <ul className="route-list">
                      {status.homeRoutes.map((route) => (
                        <li key={route.id}>
                          <span className="route-model">{route.model}</span>
                          <span className="route-meta">
                            {route.vision ? "vision" : "text"} ·{" "}
                            {Math.round(route.contextWindow / 1024)}K
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="copy muted">
                      No engine running. Start one in OYM → OPERATIONS → RUNNING.
                    </p>
                  )}
                  <button
                    className="button button-accent"
                    disabled={busy === "assistant" || status.homeRoutes.length === 0}
                    onClick={() => void startAssistant()}
                  >
                    {busy === "assistant" ? "STARTING…" : "START PRIVATE ASSISTANT"}
                  </button>
                </>
              ) : (
                <>
                  <p className="copy">
                    DeepSeek over the cloud. The API key stays in Windows Credential Manager.
                  </p>
                  <dl className="kv">
                    <dt>Model</dt>
                    <dd>deepseek-flash</dd>
                    <dt>Endpoint</dt>
                    <dd>api.deepseek.com</dd>
                    <dt>API key</dt>
                    <dd className={status.cloudKeyStored ? "" : "muted"}>
                      {status.cloudKeyStored ? "stored" : "not stored"}
                    </dd>
                  </dl>
                  <button className="link-button" onClick={() => setView("settings")}>
                    {status.cloudKeyStored ? "MANAGE API KEY" : "STORE API KEY IN SETTINGS"}
                  </button>
                  <button
                    className="button"
                    disabled={busy === "assistant" || !status.cloudKeyStored}
                    onClick={() => void startAssistant()}
                  >
                    {busy === "assistant" ? "STARTING…" : "START CLOUD ASSISTANT"}
                  </button>
                </>
              )}
            </section>

            <p className="tagline">Own your infra.</p>
          </>
        )}

        {view === "pair" && (
          <section className="card">
            <div className="card-head">
              <span className="label">PAIR THIS DEVICE</span>
              <button className="link-button" onClick={() => setView("home")}>
                BACK
              </button>
            </div>
            <p className="copy">
              In OYM → REMOTE → STATUS, copy the public endpoint and click PAIR DEVICE.
              Then enter both below.
            </p>
            <label className="field">
              <span>Gateway URL</span>
              <input
                className="input"
                autoFocus
                placeholder="wss://host/link or https://host"
                value={gateway}
                onChange={(e) => setGateway(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Pairing code</span>
              <input
                className="input"
                maxLength={12}
                placeholder="PAIRING CODE"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && code.trim() && gateway.trim()) void pair();
                }}
              />
            </label>
            <button
              className="button button-accent"
              disabled={!code.trim() || !gateway.trim() || busy === "pair"}
              onClick={() => void pair()}
            >
              {busy === "pair" ? "PAIRING…" : "PAIR"}
            </button>
          </section>
        )}

        {view === "settings" && (
          <section className="card">
            <div className="card-head">
              <span className="label">SETTINGS</span>
              <button className="link-button" onClick={() => setView("home")}>
                BACK
              </button>
            </div>
            <label className="field">
              <span>Gateway URL</span>
              <input
                className="input"
                placeholder="wss://host/link or https://host"
                value={settings.gatewayUrl}
                onChange={(e) => setSettings({ ...settings, gatewayUrl: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Device name</span>
              <input
                className="input"
                value={settings.deviceName}
                placeholder={status.deviceName || "this PC"}
                onChange={(e) => setSettings({ ...settings, deviceName: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Cloud endpoint</span>
              <input className="input" value={settings.cloudBaseUrl} readOnly />
            </label>
            <label className="field">
              <span>Cloud model</span>
              <input className="input" value={settings.cloudModel} readOnly />
            </label>
            <label className="field">
              <span>DeepSeek API key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  settings.cloudKeyStored
                    ? "stored — enter a new key to replace"
                    : "sk-…"
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && apiKey.trim()) void storeCloudKey();
                }}
              />
            </label>
            <div className="key-actions">
              <button
                className="button"
                disabled={!apiKey.trim() || busy === "cloudkey"}
                onClick={() => void storeCloudKey()}
              >
                {busy === "cloudkey" ? "STORING…" : "STORE KEY"}
              </button>
              {settings.cloudKeyStored && (
                <button className="link-button" onClick={() => void removeCloudKey()}>
                  REMOVE
                </button>
              )}
            </div>
            <p className="copy">
              The key is written to Windows Credential Manager, never to settings.json.
            </p>
            <button className="button" disabled={busy === "settings"} onClick={() => void saveSettings()}>
              {busy === "settings" ? "SAVING…" : "SAVE"}
            </button>
            <p className="copy">Portable runtime is active; the Integrated service can host the link below.</p>

            <div className="service-block">
              <div className="card-head">
                <span className="label">INTEGRATED SERVICE</span>
                <span className={`state ${service?.connected ? "is-on" : "is-off"}`}>
                  <span className="dot" />
                  {service?.connected
                    ? "ONLINE"
                    : service?.running
                      ? "RUNNING"
                      : service?.installed
                        ? "STOPPED"
                        : "NOT INSTALLED"}
                </span>
              </div>
              <p className="copy">
                Runs the link as LocalSystem. Closing the app leaves this device reachable; the
                service-owned session is SYSTEM. Paired Portable identity is handed over once at
                install.
              </p>
              <dl className="kv">
                <dt>Service</dt>
                <dd>{service?.installed ? "OymLink" : "not installed"}</dd>
                <dt>Link</dt>
                <dd>{service?.connected ? "connected" : "not connected"}</dd>
                <dt>PID</dt>
                <dd>{service?.childPid ?? service?.pid ?? "—"}</dd>
                <dt>Session</dt>
                <dd>{service?.sessionActive ? "SYSTEM active" : "none"}</dd>
              </dl>
              {service?.error && <p className="copy">{service.error}</p>}
              {busy === "service" && (
                <div className="service-progress">
                  <span className="service-spinner" aria-hidden />
                  <div>
                    <strong>APPLYING SERVICE CHANGE</strong>
                    <span>Approve the UAC prompt; the installer output appears here.</span>
                  </div>
                  <div className="service-progress-track">
                    <span />
                  </div>
                </div>
              )}
              {busy === "service" && serviceLog && (
                <pre className="service-install-log">{serviceLog.slice(-2500)}</pre>
              )}
              <div className="key-actions">
                <button
                  className="button"
                  disabled={busy === "service"}
                  onClick={() => void installService()}
                >
                  {busy === "service"
                    ? "WORKING…"
                    : service?.installed
                      ? "REINSTALL SERVICE"
                      : "INSTALL SERVICE"}
                </button>
                {service?.installed && (
                  <button className="link-button" onClick={() => void uninstallService()}>
                    UNINSTALL
                  </button>
                )}
              </div>
              <p className="copy">Install and removal require a UAC prompt.</p>
            </div>
          </section>
        )}

        {boot?.error && <p className="banner banner-bad">{boot.error}</p>}
        {error && <p className="banner banner-bad">{error}</p>}
        {notice && <p className="banner banner-ok">{notice}</p>}
      </main>

      <footer className="footer">
        <span>OYM {status.version} · BUILD {__LINK_BUILD__}</span>
        <div className="footer-actions">
          <button className="link-button" onClick={() => setView("settings")}>
            SETTINGS
          </button>
          <button className="link-button" onClick={hide}>
            HIDE
          </button>
        </div>
      </footer>
    </div>
  );
}

function HelperScreen({
  boot,
  status,
  stopped,
  forgotten,
  link,
  onStop,
  onReconnect,
  onForget,
  onClose,
}: {
  boot: Bootstrap;
  status: Status;
  stopped: boolean;
  forgotten: boolean;
  link: HelperLink | null;
  onStop: () => void;
  onReconnect: () => void;
  onForget: () => void;
  onClose: () => void;
}) {
  const failed = !boot.paired;
  const linked = Boolean(link?.linked) && !stopped && !forgotten;
  const active = linked && Boolean(link?.sessionActive);
  const label = failed
    ? "NOT CONNECTED"
    : forgotten
      ? "DEVICE FORGOTTEN"
      : stopped
        ? "DISCONNECTED"
        : active
          ? "SESSION ACTIVE"
          : linked
            ? "CONNECTED"
            : "CONNECTING";
  const copy = failed
    ? "This support link could not be completed."
    : forgotten
      ? "This PC is no longer paired. Request a new helper package to reconnect."
      : stopped
        ? "Remote access is off. No one can connect to this PC."
        : active
          ? `${boot.owner ?? "Your technician"} has control of this session.`
          : linked
            ? `Waiting for ${boot.owner ?? "your technician"} to connect.`
            : "Contacting the support gateway…";

  return (
    <div className="app helper">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">O</span>
          <span className="brand-name">OYM</span>
          <span className="mode-chip">HELP</span>
        </div>
        <button className="icon-button" title="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <main className="helper-content">
        <div
          className={`helper-orb ${linked ? "is-on" : ""} ${stopped || forgotten || failed ? "is-bad" : ""}`}
        />
        <h1>{label}</h1>
        <p className="helper-copy">{copy}</p>
        <dl className="kv helper-kv">
          <dt>Device</dt>
          <dd>{status.deviceName || boot.deviceName || "this PC"}</dd>
          <dt>Gateway</dt>
          <dd>{status.gateway || boot.gateway || "not configured"}</dd>
        </dl>
        {boot.error && <p className="banner banner-bad">{boot.error}</p>}
        {!failed && !forgotten && (
          <>
            <div className="helper-actions">
              {stopped ? (
                <>
                  <button className="button button-accent" onClick={onReconnect}>
                    RECONNECT
                  </button>
                  <button className="button button-danger" onClick={onForget}>
                    FORGET DEVICE
                  </button>
                </>
              ) : (
                <button className="button button-danger" onClick={onStop}>
                  DISCONNECT
                </button>
              )}
            </div>
            <p className="helper-note">
              {active
                ? "Disconnect immediately ends the remote session."
                : stopped
                  ? "Forget removes this PC's pairing; reconnecting then needs a new helper."
                  : "Keep this window open while your technician is helping."}
            </p>
          </>
        )}
      </main>
    </div>
  );
}

