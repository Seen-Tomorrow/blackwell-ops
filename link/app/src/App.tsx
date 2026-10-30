import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Status = {
  mode: string;
  connected: boolean;
  paired: boolean;
  deviceName: string;
  gateway: string;
  version: string;
  homeModels: number;
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

const DEFAULT_STATUS: Status = {
  mode: "portable",
  connected: false,
  paired: false,
  deviceName: "",
  gateway: "",
  version: "0.1.0",
  homeModels: 0,
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

  useEffect(() => {
    void refresh();
    void loadSettings();
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
      await invoke("link_assistant_start");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

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

  return (
    <div className="app">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">O</span>
          <span className="brand-name">OYM</span>
          <span className="mode-chip">{status.mode.toUpperCase()}</span>
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
                <span className="label">LOCAL ASSISTANT</span>
                <span className="chip">DEEPSEEK FLASH</span>
              </div>
              <p className="copy">Pi runs on this machine. Models never leave it unless you pick cloud.</p>
              <dl className="kv">
                <dt>Home models</dt>
                <dd>{status.homeModels > 0 ? `${status.homeModels} route(s)` : "no engine running"}</dd>
                <dt>Cloud key</dt>
                <dd className={status.cloudKeyStored ? "" : "muted"}>
                  {status.cloudKeyStored ? "stored" : "not stored"}
                </dd>
              </dl>
              <button
                className="button button-accent"
                disabled={busy === "assistant"}
                onClick={() => void startAssistant()}
              >
                {busy === "assistant" ? "STARTING…" : "START LOCAL ASSISTANT"}
              </button>
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
            <div className="kv">
              <dt>Cloud key</dt>
              <dd className={settings.cloudKeyStored ? "" : "muted"}>
                {settings.cloudKeyStored ? "stored in Credential Manager" : "not stored"}
              </dd>
            </div>
            <button className="button" disabled={busy === "settings"} onClick={() => void saveSettings()}>
              {busy === "settings" ? "SAVING…" : "SAVE"}
            </button>
            <p className="copy">Integrated mode, service install and transcripts arrive in the next slices.</p>
          </section>
        )}

        {error && <p className="banner banner-bad">{error}</p>}
        {notice && <p className="banner banner-ok">{notice}</p>}
      </main>

      <footer className="footer">
        <span>OYM {status.version}</span>
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
