import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Status = {
  mode: string;
  connected: boolean;
  deviceName: string;
  gateway: string;
  version: string;
  homeModels: number;
  cloudModel: string;
  cloudKeyStored: boolean;
};

type Settings = {
  deviceName: string;
  cloudBaseUrl: string;
  cloudModel: string;
  cloudKeyStored: boolean;
};

const DEFAULT_STATUS: Status = {
  mode: "portable",
  connected: false,
  deviceName: "",
  gateway: "",
  version: "0.1.0",
  homeModels: 0,
  cloudModel: "deepseek-flash",
  cloudKeyStored: false,
};

const DEFAULT_SETTINGS: Settings = {
  deviceName: "",
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
      setSettings(await invoke<Settings>("link_settings_get"));
    } catch {
      setSettings(DEFAULT_SETTINGS);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadSettings();
    const timer = window.setInterval(() => void refresh(), 5000);
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
      await invoke("link_pair", { code: code.trim() });
      setNotice("Paired. Connecting…");
      setCode("");
      setView("home");
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  }, [code, refresh]);

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
                  {status.connected ? "ONLINE" : "OFFLINE"}
                </span>
              </div>
              <dl className="kv">
                <dt>Gateway</dt>
                <dd className={status.gateway ? "" : "muted"}>{status.gateway || "not paired"}</dd>
                <dt>Device</dt>
                <dd className={status.deviceName ? "" : "muted"}>{status.deviceName || "—"}</dd>
              </dl>
              <button className="button" onClick={() => setView("pair")}>
                {status.gateway ? "REPAIR DEVICE" : "PAIR DEVICE"}
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
              In OYM → REMOTE → STATUS, click PAIR DEVICE. Enter the one-time code below.
            </p>
            <input
              className="input"
              autoFocus
              maxLength={12}
              placeholder="PAIRING CODE"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.trim()) void pair();
              }}
            />
            <button className="button button-accent" disabled={!code.trim() || busy === "pair"} onClick={() => void pair()}>
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
