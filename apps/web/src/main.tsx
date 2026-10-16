import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Clock,
  Send,
  Search,
  RefreshCw,
  Star,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  Upload,
  X,
  Plus,
  LogOut,
  Settings,
  Activity,
  Check,
  AlertCircle,
  Mail,
  ExternalLink,
  CalendarDays,
  LoaderCircle,
  SlidersHorizontal,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Quote,
  Undo2,
  Redo2,
} from "lucide-react";
import {
  api,
  setCsrf,
  type User,
  type Sender,
  type Email,
  type Config,
  type Slack,
} from "./api";
import Compose from "./Compose";
import SettingsPanel from "./SettingsPanel";
import { Spinner, Avatar, Badge, date, plain } from "./ui";
import "./styles.css";

function App() {
  const [config, setConfig] = useState<Config | null>(null),
    [user, setUser] = useState<User | null>(null),
    [boot, setBoot] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState("");
  const [section, setSection] = useState<"scheduled" | "sent">("scheduled"),
    [screen, setScreen] = useState<"mail" | "compose" | "details">("mail"),
    [selected, setSelected] = useState<Email | null>(null);
  const [settings, setSettings] = useState(false),
    [menu, setMenu] = useState(false),
    [senders, setSenders] = useState<Sender[]>([]),
    [slack, setSlack] = useState<Slack>({ connected: false, alerts: [] }),
    [stats, setStats] = useState<Record<string, number>>({});
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [items, setItems] = useState<Email[]>([]),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState(false),
    [statusFilter, setStatusFilter] = useState("all");
  const requestNumber = useRef(0);
  const refreshMeta = useCallback(async () => {
    const [s, l, t] = await Promise.all([
      api<Sender[]>("/senders"),
      api<Slack>("/slack"),
      api<Record<string, number>>("/stats"),
    ]);
    setSenders(s);
    setSlack(l);
    setStats(t);
  }, []);
  const load = useCallback(
    async (quiet = false) => {
      const version = ++requestNumber.current;
      if (!quiet) setBusy(true);
      try {
        const data = await api<{ items: Email[]; total: number }>(
          `/emails?section=${section}&q=${encodeURIComponent(query)}&page=${page}`,
        );
        if (version === requestNumber.current) {
          setItems(data.items);
          setTotal(data.total);
          setError("");
        }
      } catch (e) {
        if (version === requestNumber.current) setError((e as Error).message);
      } finally {
        if (version === requestNumber.current) setBusy(false);
      }
    },
    [section, query, page],
  );
  useEffect(() => {
    let live = true;
    Promise.all([
      api<Config>("/config"),
      api<User>("/me").catch((e) => {
        if (e.status === 401) return null;
        throw e;
      }),
    ])
      .then(([c, u]) => {
        if (!live) return;
        setConfig(c);
        setUser(u);
        if (u) setCsrf(u.csrf);
      })
      .catch((e) => setError(e.message))
      .finally(() => {
        if (live) setBoot(false);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (!user) return;
    void refreshMeta().catch((e) => setError(e.message));
    void load();
    const timer = setInterval(() => {
      void load(true);
      void refreshMeta().catch(() => {});
    }, 5000);
    return () => {
      clearInterval(timer);
      requestNumber.current++;
    };
  }, [user, refreshMeta, load]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.has("error"))
      setError((params.get("error") || "").replaceAll("_", " "));
    if (params.get("connected") === "slack")
      setToast("Slack connected. Rate-limit alerts are ready.");
    if (params.has("error") || params.has("connected"))
      history.replaceState({}, "", location.pathname);
  }, []);
  async function logout() {
    try {
      await api("/logout", { method: "POST" });
      setUser(null);
      setCsrf("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function toggleStar(email: Email) {
    try {
      await api(`/emails/${email.id}/star`, {
        method: "PATCH",
        body: JSON.stringify({ starred: !email.starred }),
      });
      setItems((old) =>
        old.map((x) => (x.id === email.id ? { ...x, starred: !x.starred } : x)),
      );
      if (selected?.id === email.id)
        setSelected({ ...email, starred: !email.starred });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (boot)
    return (
      <div className="center-screen">
        <Spinner />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!user)
    return (
      <main className="login">
        <div className="login-card">
          <div className="brand-mini">
            ONB<span>REACHINBOX</span>
          </div>
          <h1>Login</h1>
          <p className="muted">Your emails. Right on time.</p>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <a
            className={`google-button ${!config?.googleReady ? "disabled" : ""}`}
            href={config?.googleReady ? "/auth/google" : undefined}
          >
            <span className="google-g">G</span>Login with Google
          </a>
          <div className="login-divider">
            <span>Secure sign-in</span>
          </div>
          <p className="login-note">
            Schedule emails, track delivery and keep every sender in sync.
          </p>
          {!config?.googleReady && (
            <div className="setup-note">
              Google login needs configuration. Follow{" "}
              <strong>docs/SETUP.md</strong> to add your OAuth credentials.
            </div>
          )}
          {config?.localLogin && (
            <button
              className="outline full"
              onClick={async () => {
                try {
                  await api("/local-login", { method: "POST" });
                  location.reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Developer login — local testing only
            </button>
          )}
          <div className="test-note">
            <span className="dot" />
            Ethereal test environment · No real recipient delivery
          </div>
        </div>
      </main>
    );
  const scheduled =
      (stats.scheduled || 0) + (stats.deferred || 0) + (stats.sending || 0),
    sent = (stats.sent || 0) + (stats.failed || 0) + (stats.uncertain || 0);
  return (
    <>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
      {screen === "compose" ? (
        <Compose
          user={user}
          config={config!}
          senders={senders}
          onClose={() => setScreen("mail")}
          onSetup={() => setSettings(true)}
          onDone={async (count) => {
            setScreen("mail");
            setSection("scheduled");
            setSearch("");
            setPage(1);
            setToast(
              `${count} emails scheduled. You can safely close this page.`,
            );
            await refreshMeta();
            await load();
          }}
        />
      ) : screen === "details" && selected ? (
        <main className="detail">
          <header className="page-header">
            <button
              className="icon"
              aria-label="Back to emails"
              onClick={() => setScreen("mail")}
            >
              <ArrowLeft />
            </button>
            <h1>{selected.subject}</h1>
            <button
              className="icon"
              aria-label="Star email"
              onClick={() => void toggleStar(selected)}
            >
              <Star className={selected.starred ? "is-starred" : ""} />
            </button>
            <Avatar user={user} />
          </header>
          <article className="message">
            <div className="message-head">
              <span className="avatar initials">
                {selected.sender_name.charAt(0)}
              </span>
              <div>
                <strong>{selected.sender_name}</strong>{" "}
                <span className="muted">&lt;{selected.sender_email}&gt;</span>
                <p className="muted">to {selected.recipient}</p>
              </div>
              <time>{date(selected.sent_at || selected.scheduled_at)}</time>
            </div>
            <Badge email={selected} />
            <div
              className="message-body"
              dangerouslySetInnerHTML={{ __html: selected.body }}
            />
            <div className="delivery-details">
              <h3>Delivery details</h3>
              <dl>
                <dt>Scheduled</dt>
                <dd>{date(selected.scheduled_at)}</dd>
                <dt>Next eligible time</dt>
                <dd>{date(selected.next_attempt_at)}</dd>
                <dt>Sent</dt>
                <dd>{date(selected.sent_at)}</dd>
                <dt>Attempts</dt>
                <dd>{selected.attempts}</dd>
              </dl>
              {selected.error && (
                <div className="warning">
                  <AlertCircle size={16} />
                  {selected.error}
                </div>
              )}
              {selected.preview_url && (
                <a
                  className="outline"
                  href={selected.preview_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  View in Ethereal <ExternalLink size={15} />
                </a>
              )}
            </div>
          </article>
        </main>
      ) : (
        <div className="workspace">
          <aside className="sidebar">
            <div className="wordmark">ONB</div>
            <div className="profile-area">
              <button
                className="profile"
                onClick={() => setMenu(!menu)}
                aria-expanded={menu}
              >
                <Avatar user={user} />
                <span>
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                </span>
                <ChevronDown size={14} />
              </button>
              {menu && (
                <div className="profile-menu">
                  <button
                    onClick={() => {
                      setMenu(false);
                      setSettings(true);
                    }}
                  >
                    <Settings size={16} />
                    Settings & integrations
                  </button>
                  <button onClick={() => void logout()}>
                    <LogOut size={16} />
                    Logout
                  </button>
                </div>
              )}
            </div>
            <button
              className="compose-button"
              onClick={() => setScreen("compose")}
            >
              Compose
            </button>
            <div className="nav-label">CORE</div>
            <nav aria-label="Mailbox">
              <button
                className={section === "scheduled" ? "active" : ""}
                onClick={() => {
                  setSection("scheduled");
                  setPage(1);
                  setStatusFilter("all");
                }}
              >
                <Clock size={17} />
                Scheduled<span>{scheduled}</span>
              </button>
              <button
                className={section === "sent" ? "active" : ""}
                onClick={() => {
                  setSection("sent");
                  setPage(1);
                  setStatusFilter("all");
                }}
              >
                <Send size={17} />
                Sent<span>{sent}</span>
              </button>
            </nav>
            <div className="sidebar-bottom">
              <button onClick={() => setSettings(true)}>
                <Settings size={16} />
                Senders & integrations
              </button>
              {user.isAdmin && (
                <a href="/admin/queues" target="_blank" rel="noreferrer">
                  <Activity size={16} />
                  Queue monitor
                  <ExternalLink size={12} />
                </a>
              )}
              <div className="environment">
                <span className="dot" />
                Ethereal sandbox
              </div>
            </div>
          </aside>
          <main className="mailbox">
            <header className="mail-toolbar">
              <div className="search-box">
                <Search size={16} />
                <input
                  aria-label="Search emails"
                  placeholder="Search emails, subjects and messages"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    className="icon small"
                    aria-label="Clear search"
                    onClick={() => setSearch("")}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <button
                className={`icon ${filter ? "pressed" : ""}`}
                aria-label="Filter emails"
                onClick={() => setFilter(!filter)}
              >
                <SlidersHorizontal size={16} />
              </button>
              <button
                className="icon"
                aria-label="Refresh emails"
                onClick={() => void load()}
                disabled={busy}
              >
                {busy ? <Spinner /> : <RefreshCw size={16} />}
              </button>
            </header>
            {filter && (
              <div className="filter-bar">
                <label>
                  Status on this page{" "}
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="all">All</option>
                    {(section === "sent"
                      ? ["sent", "failed", "uncertain"]
                      : ["scheduled", "deferred", "sending"]
                    ).map((s) => (
                      <option key={s} value={s}>
                        {s === "uncertain" ? "Needs review" : s}
                      </option>
                    ))}
                  </select>
                </label>
                <span>
                  Times shown in{" "}
                  {Intl.DateTimeFormat().resolvedOptions().timeZone}
                </span>
              </div>
            )}
            {error && (
              <div className="error" role="alert">
                <AlertCircle size={16} />
                {error}
                <button className="text-button" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            )}
            {busy && items.length === 0 ? (
              <div className="skeletons">
                {[1, 2, 3, 4].map((x) => (
                  <div className="skeleton" key={x} />
                ))}
              </div>
            ) : !items.length ? (
              <div className="empty">
                <span className="empty-icon">
                  {search ? (
                    <Search size={28} />
                  ) : section === "scheduled" ? (
                    <Clock size={28} />
                  ) : (
                    <Send size={28} />
                  )}
                </span>
                <h2>
                  {search
                    ? "No matching emails"
                    : section === "scheduled"
                      ? "Your next send starts here"
                      : "No sent emails yet"}
                </h2>
                <p>
                  {search
                    ? "Try a different search. Newly indexed emails can take a moment to appear."
                    : section === "scheduled"
                      ? "Compose an email, add your recipients and choose when it goes out."
                      : "Delivery results appear here after the worker processes your scheduled emails."}
                </p>
                {!search && section === "scheduled" && (
                  <button
                    className="primary"
                    onClick={() => setScreen("compose")}
                  >
                    <Plus size={16} />
                    Compose new email
                  </button>
                )}
              </div>
            ) : (
              <div className="email-list">
                {items
                  .filter(
                    (e) => statusFilter === "all" || e.status === statusFilter,
                  )
                  .map((email) => (
                    <div className="email-row" key={email.id}>
                      <button
                        className="email-open"
                        onClick={() => {
                          setSelected(email);
                          setScreen("details");
                        }}
                      >
                        <span className="recipient">To: {email.recipient}</span>
                        <span className="email-summary">
                          <Badge email={email} />
                          <strong>{email.subject}</strong>
                          <span className="snippet">
                            {" "}
                            — {plain(email.body)}
                          </span>
                        </span>
                        <time>
                          {section === "sent"
                            ? date(email.sent_at || email.scheduled_at)
                            : ""}
                        </time>
                      </button>
                      <button
                        className="icon small"
                        aria-label={
                          email.starred ? "Unstar email" : "Star email"
                        }
                        onClick={() => void toggleStar(email)}
                      >
                        <Star
                          size={15}
                          className={email.starred ? "is-starred" : ""}
                        />
                      </button>
                    </div>
                  ))}
              </div>
            )}
            {total > 0 && (
              <footer className="pagination">
                <span>
                  {(page - 1) * 25 + 1}–{Math.min(page * 25, total)} of {total}{" "}
                  {query && "· Elasticsearch"}
                </span>
                <button
                  className="icon"
                  aria-label="Previous page"
                  disabled={page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft size={17} />
                </button>
                <button
                  className="icon"
                  aria-label="Next page"
                  disabled={page * 25 >= total}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight size={17} />
                </button>
              </footer>
            )}
          </main>
        </div>
      )}
      {settings && (
        <SettingsPanel
          senders={senders}
          slack={slack}
          config={config!}
          onClose={() => setSettings(false)}
          refresh={refreshMeta}
          notify={setToast}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
