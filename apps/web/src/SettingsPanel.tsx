import { useEffect, useState, useRef } from "react";
import { X, Plus, Check, ExternalLink } from "lucide-react";
import { api, type Sender, type Slack, type Config } from "./api";
import { Spinner } from "./ui";
export default function SettingsPanel({
  senders,
  slack,
  config,
  onClose,
  refresh,
  notify,
}: {
  senders: Sender[];
  slack: Slack;
  config: Config;
  onClose: () => void;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const controls = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], input:not(:disabled), select",
        ) || [],
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [connectingSlack, setConnectingSlack] = useState(false);
  const [slackIssues, setSlackIssues] = useState<string[]>([]);
  useEffect(() => {
    void api<Record<string, boolean>>("/health")
      .then(setHealth)
      .catch(() => {});
  }, []);
  async function addSender() {
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("/senders", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      await refresh();
      setName("");
      notify("Ethereal test sender created.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function connectSlack() {
    setConnectingSlack(true);
    setSlackIssues([]);
    try {
      // Recheck the server so configuration fixed after page load is recognized.
      const latest = await api<Config>("/config");
      if (!latest.slackReady) {
        setSlackIssues(
          latest.slackIssues?.length
            ? latest.slackIssues
            : [
                "Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and an HTTPS SLACK_CALLBACK_URL in your local .env file.",
              ],
        );
        return;
      }
      window.location.assign("/auth/slack");
    } catch (error) {
      setSlackIssues([(error as Error).message]);
    } finally {
      setConnectingSlack(false);
    }
  }
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header>
          <div>
            <h2 id="settings-title">Senders & integrations</h2>
            <p className="muted">Everything your scheduler needs.</p>
          </div>
          <button
            className="icon"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <section>
          <h3>
            Email senders <span className="count-pill">{senders.length}</span>
          </h3>
          <p className="helper">
            Each sender uses a separate Ethereal test account. No email reaches
            a real recipient.
          </p>
          {senders.map((s) => (
            <div className="sender-card" key={s.id}>
              <span className="avatar initials">{s.name.charAt(0)}</span>
              <div>
                <strong>{s.name}</strong>
                <small>{s.email}</small>
                <div className="usage-track">
                  <span
                    style={{
                      width: `${Math.min(100, ((s.used || 0) / s.hourly_limit) * 100)}%`,
                    }}
                  />
                </div>
                <small>
                  {s.used || 0} / {s.hourly_limit} attempts this hour ·{" "}
                  {s.delay_ms / 1000}s spacing
                </small>
              </div>
            </div>
          ))}
          <div className="add-sender">
            <input
              aria-label="New sender name"
              placeholder="Sender name, e.g. Viswajit"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addSender();
              }}
            />
            <button
              className="primary"
              disabled={busy || !name.trim()}
              onClick={() => void addSender()}
            >
              {busy ? <Spinner /> : <Plus size={16} />}Add sender
            </button>
          </div>
        </section>
        <section className="slack-section">
          <div className="integration-title">
            <div className="slack-mark">#</div>
            <div>
              <h3>Slack notifications</h3>
              <p className="helper">
                Get notified when a sender reaches its hourly limit.
              </p>
            </div>
          </div>
          <div className="slack-actions">
            {slack.connected ? (
              <>
                <div className="connected">
                  <Check size={16} />
                  Connected to {slack.team_name} · {slack.channel_name}
                </div>
                <button
                  className="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api("/slack", { method: "DELETE" });
                      await refresh();
                      notify("Slack disconnected.");
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Disconnect Slack
                </button>
              </>
            ) : (
              <button
                type="button"
                className="outline slack-connect-button"
                disabled={connectingSlack}
                onClick={() => void connectSlack()}
                aria-describedby="slack-help"
              >
                {connectingSlack ? <Spinner /> : null}
                {connectingSlack ? "Checking setup…" : "Connect Slack"}
                {!connectingSlack && <ExternalLink size={14} />}
              </button>
            )}
            {!slack.connected && (
              <p className="helper" id="slack-help">
                {config.slackReady
                  ? "Choose a workspace and channel to receive alerts."
                  : "Slack needs setup. Click Connect Slack to check what is missing."}
              </p>
            )}
            {slackIssues.length > 0 && (
              <div className="slack-setup-note" role="alert">
                <strong>Finish Slack setup</strong>
                <ul>
                  {slackIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
                <p>
                  Save .env, restart the API, then click Connect Slack again.
                  Register the same HTTPS callback in your Slack app’s OAuth
                  &amp; Permissions settings.
                </p>
              </div>
            )}
            {slack.alerts.length > 0 && (
              <p className="helper">
                Alerts:{" "}
                {slack.alerts.map((x) => `${x.count} ${x.status}`).join(" · ")}
              </p>
            )}
          </div>
        </section>
        <section>
          <h3>Service status</h3>
          {health ? (
            <div className="health-grid">
              {Object.entries(health).map(([key, ok]) => (
                <span key={key}>
                  <span className={`dot ${ok ? "" : "red"}`} />
                  {key}
                  <small>{ok ? "Connected" : "Unavailable"}</small>
                </span>
              ))}
            </div>
          ) : (
            <p className="helper">Checking database, queue and search…</p>
          )}
        </section>
      </section>
    </div>
  );
}
