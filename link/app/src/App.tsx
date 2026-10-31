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

type LinkUpdateInfo = {
  available: boolean;
  currentBuild: number;
  latestBuild: number | null;
  name: string | null;
  url: string | null;
  sizeBytes: number | null;
  publishedAt: string | null;
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
  const [serviceApply, setServiceApply] = useState<"install" | "uninstall" | null>(null);
  const [serviceStartedAt, setServiceStartedAt] = useState(0);
  const [serviceElapsed, setServiceElapsed] = useState(0);
  const [elevated, setElevated] = useState(false);
  const [networkEnabled, setNetworkEnabled] = useState(true);
  const [cloudStatus, setCloudStatus] = useState("checking");
  const [pendingMode, setPendingMode] = useState<"portable" | "integrated" | null>(null);
  const [updateInfo, setUpdateInfo] = useState<LinkUpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    const saved = window.localStorage.getItem("oym.link.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
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
    if (!serviceApply) {
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
  }, [serviceApply, serviceStartedAt]);

  useEffect(() => {
    if (!serviceApply) return;
    setServiceElapsed(0);
    const ticker = window.setInterval(() => setServiceElapsed((value) => value + 1), 1000);
    const timeout = window.setTimeout(() => setServiceApply(null), 30000);
    return () => {
      window.clearInterval(ticker);
      window.clearTimeout(timeout);
    };
  }, [serviceApply, serviceStartedAt]);

  useEffect(() => {
    if (!serviceApply) return;
    let cancelled = false;
    const check = async () => {
      try {
        const raw = await invoke<string>("service_action_status");
        if (!cancelled && raw) {
          try {
            const marker = JSON.parse(raw) as { action?: string; at?: number };
            if (marker.action === serviceApply && Number(marker.at ?? 0) >= serviceStartedAt) {
              setServiceApply(null);
            }
          } catch {
            // ignore a partial write
          }
        }
      } catch {
        // keep the 90s fallback timer
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [serviceApply, serviceStartedAt]);

  useEffect(() => {
    void invoke<boolean>("link_is_elevated")
      .then(setElevated)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void invoke<boolean>("link_network_status")
      .then(setNetworkEnabled)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const load = () => {
      void invoke<string>("link_cloud_status")
        .then(setCloudStatus)
        .catch(() => setCloudStatus("offline"));
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, [networkEnabled, settings.cloudKeyStored]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.oymTheme = resolved;
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const cycleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "system" ? "light" : current === "light" ? "dark" : "system";
      window.localStorage.setItem("oym.link.theme", next);
      return next;
    });
  }, []);

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
    if (!boot?.paired) return;
    const load = () => {
      void invoke<HelperLink>("helper_link_status")
        .then(setHelperLink)
        .catch(() => {});
    };
    void load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [boot?.paired]);

  useEffect(() => {
    if (boot && !boot.paired && !boot.helper) setView("pair");
  }, [boot?.paired, boot?.helper]);

  useEffect(() => {
    if (!boot?.paired) return;
    void invoke<LinkUpdateInfo>("link_update_check", { currentBuild: __LINK_BUILD__ })
      .then(setUpdateInfo)
      .catch(() => {});
  }, [boot?.paired]);

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

  const startAssistant = useCallback(async (selected: "private" | "cloud" = provider) => {
    setError(null);
    setNotice(null);
    setBusy("assistant");
    try {
      const resolvedTheme =
        theme === "system"
          ? window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark"
          : theme;
      await invoke("assistant_open", { provider: selected, theme: resolvedTheme });
      setNotice("Assistant terminal opened.");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [provider, theme]);

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
    setServiceLog("");
    setServiceApply("install");
    setServiceStartedAt(Math.floor(Date.now() / 1000));
    setBusy("service");
    try {
      await invoke("service_install");
      setNotice("UAC prompt opened. Keep this window open; progress appears below.");
      window.setTimeout(() => void loadService(), 4000);
    } catch (e) {
      setServiceApply(null);
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [loadService]);

  const uninstallService = useCallback(async () => {
    setError(null);
    setNotice(null);
    setServiceLog("");
    setServiceApply("uninstall");
    setServiceStartedAt(Math.floor(Date.now() / 1000));
    setBusy("service");
    try {
      await invoke("service_uninstall");
      setNotice("UAC prompt opened for service removal. Keep this window open.");
      window.setTimeout(() => void loadService(), 4000);
    } catch (e) {
      setServiceApply(null);
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [loadService]);

  const restartElevated = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await invoke("link_restart_elevated");
      setNotice("Elevation prompt opened; OYM Link will restart as admin.");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, []);

  const restartNormal = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await invoke("link_restart_normal");
      setNotice("Restarting with your normal user token…");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, []);

  const toggleNetwork = useCallback(async () => {
    const next = !networkEnabled;
    setError(null);
    setNotice(null);
    try {
      await invoke("link_network_set", { enabled: next });
      setNetworkEnabled(next);
      setCloudStatus(next ? "checking" : "disabled");
      setNotice(next ? "Network access enabled." : "Network access stopped.");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, [networkEnabled]);

  const installUpdate = useCallback(async () => {
    if (!updateInfo?.url || !updateInfo.name) return;
    setError(null);
    setNotice(null);
    setUpdateBusy(true);
    try {
      await invoke("link_update_install", {
        url: updateInfo.url,
        name: updateInfo.name,
      });
      setNotice("Update started. OYM Link will close and relaunch.");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      setUpdateBusy(false);
    }
  }, [updateInfo]);

  const confirmMode = useCallback(async () => {
    const target = pendingMode;
    setPendingMode(null);
    if (target === "integrated") {
      await installService();
    } else if (target === "portable") {
      await uninstallService();
    }
  }, [pendingMode, installService, uninstallService]);

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

  const integrated = Boolean(service?.installed);
  const linked = integrated ? Boolean(service?.connected) : Boolean(helperLink?.linked);
  const sessionActive = integrated
    ? Boolean(service?.sessionActive)
    : Boolean(helperLink?.sessionActive);
  const blackwellOnline = networkEnabled && linked;
  const cloudReady = networkEnabled && cloudStatus === "ready";
  const operatorLabel = !networkEnabled
    ? "REMOTE OFF"
    : sessionActive
      ? "OPERATOR CONNECTED · ACTIVE"
      : linked
        ? "OPERATOR CONNECTED · IDLE"
        : "WAITING FOR OPERATOR";
  const actionLabel =
    serviceApply === "install"
      ? "Integrating with Windows…"
      : serviceApply === "uninstall"
        ? "Returning to portable…"
        : "Ready";
  const cloudLabel = !networkEnabled
    ? "Off"
    : cloudStatus === "ready"
      ? "Ready"
      : cloudStatus === "offline"
        ? "Offline"
        : cloudStatus === "not-configured"
          ? "Not configured"
          : "Checking";

  return (
    <div className="app">
      <header className="titlebar dash-titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">O</span>
          <span className="brand-name">OYM</span>
        </div>
        <div className="header-actions">
          {updateInfo?.available && (
            <button
              type="button"
              className="update-button"
              disabled={updateBusy}
              title={`Update OYM Link to build ${updateInfo.latestBuild ?? "?"}`}
              onClick={() => void installUpdate()}
            >
              {updateBusy ? "UPDATING" : `UPDATE ${updateInfo.latestBuild ?? ""}`}
            </button>
          )}
          <button
            className="icon-button"
            title={`Theme: ${theme}. Click to change.`}
            onClick={cycleTheme}
          >
            {theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐"}
          </button>
          <button
            className="icon-button"
            title="Config"
            onClick={() => setView(view === "settings" ? "home" : "settings")}
          >
            ⚙
          </button>
          <button className="icon-button icon-button--close" title="Hide" onClick={hide}>
            ×
          </button>
        </div>
      </header>

      <main className="content dash-scroll">
        {view === "home" && (
          <>
            <section className={`dash-card mode-card ${integrated ? "is-integrated" : "is-portable"}`}>
              <div className="dash-card-head">
                <span className="dash-label">MODE</span>
                <span className="dash-note">{integrated ? "Always available" : "Runs while open"}</span>
              </div>
              <div className="mode-switch">
                <button
                  type="button"
                  className={`mode-option ${!integrated ? "is-active" : ""}`}
                  disabled={serviceApply !== null}
                  onClick={() => {
                    if (integrated) setPendingMode("portable");
                  }}
                >
                  PORTABLE
                </button>
                <button
                  type="button"
                  className={`mode-option ${integrated ? "is-active" : ""}`}
                  disabled={serviceApply !== null}
                  onClick={() => {
                    if (!integrated) setPendingMode("integrated");
                  }}
                >
                  INTEGRATED
                </button>
              </div>
            </section>

            <section className={`dash-card privilege-card ${integrated || elevated ? "is-high" : "is-low"}`}>
              <div className="dash-card-head">
                <span className="dash-label">PRIVILEGE</span>
                <span className={`dash-value ${integrated || elevated ? "is-accent" : ""}`}>
                  {integrated ? "MAXIMUM" : elevated ? "HIGH" : "LOW"}
                </span>
              </div>
              <div className="dash-row">
                <span className="dash-copy privilege-meta">
                  <span>{integrated ? "SYSTEM LEVEL" : elevated ? "ADMIN LEVEL" : "USER LEVEL"}</span>
                  {(integrated || elevated) && <span className="privilege-sep" />}
                  {integrated && <span>always available, survives restarts</span>}
                  {!integrated && elevated && <span>temporary admin, until restart</span>}
                </span>
                {!integrated && (
                  <button
                    type="button"
                    className="soft-button"
                    onClick={() => void (elevated ? restartNormal() : restartElevated())}
                  >
                    {elevated ? "SWITCH TO LOW" : "SWITCH TO HIGH"}
                  </button>
                )}
              </div>
            </section>

            <section className="dash-card">
              <div className="dash-card-head">
                <span className="dash-label">LOCAL ASSISTANT</span>
              </div>
              <div className="mode-switch assistant-switch">
                <button
                  type="button"
                  className={`mode-option assistant-option ${provider === "private" ? "is-active" : ""}`}
                  onClick={() => setProvider("private")}
                >
                  PRIVATE
                </button>
                <button
                  type="button"
                  className={`mode-option assistant-option ${provider === "cloud" ? "is-active" : ""}`}
                  disabled={!cloudReady || !status.cloudKeyStored}
                  onClick={() => setProvider("cloud")}
                >
                  CLOUD
                </button>
              </div>
              <div className="dash-row">
                <span className="dash-copy">
                  {provider === "private"
                    ? `${status.homeRoutes.length} Private model options`
                    : !status.cloudKeyStored
                      ? "Cloud key not configured"
                      : `Cloud · ${cloudLabel.toLowerCase()}`}
                </span>
                <button
                  type="button"
                  className="soft-button"
                  disabled={
                    busy === "assistant" ||
                    (provider === "private" && status.homeRoutes.length === 0) ||
                    (provider === "cloud" && (!cloudReady || !status.cloudKeyStored))
                  }
                  onClick={() => void startAssistant(provider)}
                >
                  {busy === "assistant" ? "OPENING…" : "OPEN"}
                </button>
              </div>
            </section>

            <section className="dash-card files-card">
              <span className="dash-label">FILES</span>
              <span className="dash-copy">Transfer monitor · coming soon</span>
            </section>


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
              {serviceApply && (
                <div className="service-progress">
                  <span className="service-spinner" aria-hidden />
                  <div>
                    <strong>
                      {serviceApply === "install" ? "INSTALLING SERVICE" : "REMOVING SERVICE"} ·{" "}
                      {serviceElapsed}s
                    </strong>
                    <span>
                      Approve the UAC prompt; the installer transcript appears here.
                    </span>
                  </div>
                  <div className="service-progress-track">
                    <span />
                  </div>
                </div>
              )}
              {serviceApply && serviceLog && (
                <pre className="service-install-log">{serviceLog.slice(-2500)}</pre>
              )}
              <div className="key-actions">
                <button
                  className="button"
                  disabled={serviceApply !== null}
                  onClick={() => void installService()}
                >
                  {serviceApply === "install"
                    ? "WORKING…"
                    : service?.installed
                      ? "REINSTALL SERVICE"
                      : "INSTALL SERVICE"}
                </button>
                {service?.installed && (
                  <button
                    className="link-button"
                    disabled={serviceApply !== null}
                    onClick={() => void uninstallService()}
                  >
                    {serviceApply === "uninstall" ? "REMOVING…" : "UNINSTALL"}
                  </button>
                )}
              </div>
              <p className="copy">Install and removal require a UAC prompt.</p>
            </div>

            {!service?.installed && (
              <div className="service-block">
                <div className="card-head">
                  <span className="label">PORTABLE PRIVILEGE</span>
                  <span className={`state ${elevated ? "is-on" : "is-off"}`}>
                    <span className="dot" />
                    {elevated ? "ELEVATED" : "STANDARD"}
                  </span>
                </div>
                <p className="copy">
                  Portable runs with your filtered user token. Restart as admin to let the local
                  and remote Pi sessions perform service-level work; Windows will ask for consent.
                </p>
                <button
                  className="button"
                  onClick={() => void (elevated ? restartNormal() : restartElevated())}
                >
                  {elevated ? "SWITCH TO LOW" : "SWITCH TO HIGH"}
                </button>
              </div>
            )}
            <p className="tagline">OYM {status.version} · BUILD {__LINK_BUILD__}</p>
          </section>
        )}

        {boot?.error && <p className="banner banner-bad">{boot.error}</p>}
        {error && <p className="banner banner-bad">{error}</p>}
        {notice && <p className="banner banner-ok">{notice}</p>}
      </main>

      {view === "home" && (
        <div className="bottom-dock">
          <div className={`status-rail ${networkEnabled ? "" : "is-off"}`}>
            <div className="status-head">
              <div className="status-main">{operatorLabel}</div>
              <button
                type="button"
                className={`access-toggle ${networkEnabled ? "is-stop" : "is-enable"}`}
                onClick={() => void toggleNetwork()}
              >
                {networkEnabled ? "DISABLE ACCESS" : "ENABLE ACCESS"}
              </button>
            </div>
            <div className="status-action">{actionLabel}</div>
            {serviceApply && (
              <div className="status-progress">
                <span />
              </div>
            )}
          </div>

          <footer className="dash-footer">
            <div className="footer-statuses">
              <span className={`footer-led ${blackwellOnline ? "is-on" : "is-off"}`} />
              <span className="footer-name">Blackwell</span>
              <span className={`footer-value ${blackwellOnline ? "is-on" : "is-off"}`}>
                {blackwellOnline ? "Online" : networkEnabled ? "Offline" : "Off"}
              </span>

              <span className={`footer-led ${cloudReady ? "is-on" : "is-off"}`} />
              <span className="footer-name">Cloud</span>
              <span className={`footer-value ${cloudReady ? "is-on" : "is-off"}`}>
                {cloudLabel}
              </span>
            </div>
          </footer>
        </div>
      )}

      {pendingMode && (
        <div className="modal-scrim" onClick={() => setPendingMode(null)}>
          <div className="mode-modal" onClick={(event) => event.stopPropagation()}>
            <div className="dash-label">
              {pendingMode === "integrated" ? "SWITCH TO INTEGRATED" : "SWITCH TO PORTABLE"}
            </div>
            <p className="modal-copy">
              {pendingMode === "integrated"
                ? "Installed as system level. This computer will be permanently accessible to remote operators until access is revoked. Windows will ask for permission."
                : "Installed as user level. Remote access ends when this app closes. Windows will ask for permission to stop the system service."}
            </p>
            <div className="modal-actions">
              <button type="button" className="soft-button" onClick={() => setPendingMode(null)}>
                CANCEL
              </button>
              <button type="button" className="button button-accent" onClick={() => void confirmMode()}>
                CONTINUE
              </button>
            </div>
          </div>
        </div>
      )}
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

