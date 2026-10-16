import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Clock,
  Send,
  AlertCircle,
  Upload,
  X,
  Check,
  CalendarDays,
  ChevronDown,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Quote,
  Undo2,
  Redo2,
} from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { api, type User, type Config, type Sender } from "./api";
import { parseLeads } from "./leads";
import { Spinner, date, localDate } from "./ui";
export default function Compose({
  user,
  config,
  senders,
  onClose,
  onSetup,
  onDone,
}: {
  user: User;
  config: Config;
  senders: Sender[];
  onClose: () => void;
  onSetup: () => void;
  onDone: (n: number) => Promise<void>;
}) {
  const [senderId, setSenderId] = useState(senders[0]?.id || ""),
    [subject, setSubject] = useState(""),
    [raw, setRaw] = useState(""),
    [emails, setEmails] = useState<string[]>([]),
    [report, setReport] = useState(""),
    [delay, setDelay] = useState(
      (senders[0]?.delay_ms || config.minDelayMs) / 1000,
    ),
    [limit, setLimit] = useState(
      senders[0]?.hourly_limit || config.maxHourlyLimit,
    ),
    [start, setStart] = useState(localDate(new Date(Date.now() + 5 * 60000))),
    [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const upload = useRef<HTMLInputElement>(null),
    request = useRef<{ payload: string; key: string } | null>(null);
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    editorProps: {
      attributes: {
        class: "message-editor",
        "aria-label": "Email body",
        role: "textbox",
        "aria-multiline": "true",
      },
    },
  });
  useEffect(() => {
    if (!senderId && senders[0]) {
      setSenderId(senders[0].id);
      setDelay(senders[0].delay_ms / 1000);
      setLimit(senders[0].hourly_limit);
    }
  }, [senderId, senders]);
  function changeSender(id: string) {
    setSenderId(id);
    const s = senders.find((s) => s.id === id);
    if (s) {
      setDelay(s.delay_ms / 1000);
      setLimit(s.hourly_limit);
    }
  }
  function addRecipients(text: string) {
    const p = parseLeads(text);
    const combined = [...new Set([...emails, ...p.emails])];
    setEmails(combined);
    setReport(
      `${combined.length} valid recipients · ${p.duplicates + emails.length + p.emails.length - combined.length} duplicates removed · ${p.invalid} invalid entries ignored`,
    );
    setRaw("");
  }
  async function fileSelected(file?: File) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("Lead files must be smaller than 2 MB.");
      return;
    }
    addRecipients(await file.text());
    if (upload.current) upload.current.value = "";
  }
  async function submit() {
    setError("");
    const recipients = [...new Set([...emails, ...parseLeads(raw).emails])];
    if (!senderId) {
      setError("Create an Ethereal sender first.");
      return;
    }
    if (!recipients.length) {
      setError("Add at least one valid recipient.");
      return;
    }
    if (!subject.trim() || !editor?.getText().trim()) {
      setError("Enter a subject and message.");
      return;
    }
    if (!start || new Date(start).getTime() < Date.now()) {
      setError("Choose a future start time.");
      setPicker(true);
      return;
    }
    if (recipients.length > 5000) {
      setError("Schedule up to 5,000 recipients per batch.");
      return;
    }
    const payload = JSON.stringify({
      senderId,
      recipients,
      subject,
      body: editor.getHTML(),
      startAt: new Date(start).toISOString(),
      delayMs: Math.round(delay * 1000),
      hourlyLimit: limit,
    });
    if (request.current?.payload !== payload)
      request.current = { payload, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const data = await api<{ count: number }>("/schedules", {
        method: "POST",
        headers: { "Idempotency-Key": request.current.key },
        body: payload,
      });
      await onDone(data.count);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const tools = [
    {
      label: "Undo",
      icon: Undo2,
      run: () => editor?.chain().focus().undo().run(),
    },
    {
      label: "Redo",
      icon: Redo2,
      run: () => editor?.chain().focus().redo().run(),
    },
    {
      label: "Bold",
      icon: Bold,
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: "Italic",
      icon: Italic,
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: "Underline",
      icon: Underline,
      run: () => editor?.chain().focus().toggleUnderline().run(),
    },
    {
      label: "Bullet list",
      icon: List,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: "Numbered list",
      icon: ListOrdered,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "Quote",
      icon: Quote,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
  ];
  return (
    <main className="compose-page">
      <header className="page-header">
        <button
          className="icon"
          aria-label="Back to mailbox"
          onClick={onClose}
          disabled={busy}
        >
          <ArrowLeft />
        </button>
        <h1>Compose New Email</h1>
        <div className="header-actions">
          <button
            className="icon green"
            aria-label="Choose send time"
            onClick={() => setPicker(!picker)}
          >
            <Clock size={19} />
          </button>
          <button
            className="outline"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? <Spinner /> : <Send size={14} />}Send Later
          </button>
        </div>
      </header>
      <section className="compose-content">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {senders.length === 0 && (
          <div className="warning">
            <AlertCircle size={17} />
            Create a test sender to get started.
            <button className="text-button" onClick={onSetup}>
              Set up sender
            </button>
          </div>
        )}
        <div className="compose-field">
          <label htmlFor="sender">From</label>
          <select
            id="sender"
            value={senderId}
            onChange={(e) => changeSender(e.target.value)}
          >
            {senders.length === 0 && (
              <option value="">No sender connected</option>
            )}
            {senders.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} &lt;{s.email}&gt;
              </option>
            ))}
          </select>
        </div>
        <div className="compose-field recipient-field">
          <label htmlFor="recipients">To</label>
          <div className="recipient-entry">
            {emails.slice(0, 3).map((email) => (
              <span className="recipient-chip" key={email}>
                {email}
                <button
                  aria-label={`Remove ${email}`}
                  onClick={() => setEmails(emails.filter((x) => x !== email))}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {emails.length > 3 && (
              <span className="recipient-chip">+{emails.length - 3}</span>
            )}
            <input
              id="recipients"
              placeholder={
                emails.length ? "Add recipients" : "recipient@example.com"
              }
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              onBlur={() => {
                if (raw.trim()) addRecipients(raw);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRecipients(raw);
                }
              }}
            />
          </div>
          <button
            className="text-button"
            onClick={() => upload.current?.click()}
          >
            <Upload size={14} />
            Upload List
          </button>
          <input
            ref={upload}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            hidden
            onChange={(e) => void fileSelected(e.target.files?.[0])}
          />
        </div>
        {report && (
          <div className="upload-report">
            <Check size={14} />
            {report}
            <button
              onClick={() => {
                setEmails([]);
                setReport("");
              }}
              className="text-button"
            >
              Clear
            </button>
          </div>
        )}
        <div className="compose-field subject-field">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            placeholder="Subject"
            value={subject}
            maxLength={500}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="delivery-controls">
          <label>
            Delay between 2 emails{" "}
            <input
              aria-label="Delay in seconds"
              type="number"
              min={config.minDelayMs / 1000}
              max={3600}
              step="0.1"
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
            />
            <span className="muted">sec</span>
          </label>
          <label>
            Hourly Limit{" "}
            <input
              aria-label="Hourly limit"
              type="number"
              min="1"
              max={config.maxHourlyLimit}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="editor-wrap">
          <div className="editor-placeholder">Write your message</div>
          <div
            className="editor-toolbar"
            role="toolbar"
            aria-label="Message formatting"
          >
            {tools.map((t) => (
              <button
                key={t.label}
                className="icon small"
                title={t.label}
                aria-label={t.label}
                onClick={t.run}
              >
                <t.icon size={16} />
              </button>
            ))}
          </div>
          <EditorContent editor={editor} />
        </div>
        <div className="schedule-summary">
          <button className="schedule-time" onClick={() => setPicker(!picker)}>
            <CalendarDays size={16} />
            {date(start)}
            <ChevronDown size={14} />
          </button>
          <span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          <span>{emails.length} recipients</span>
        </div>
        <p className="helper">
          Limits apply across this sender’s pending emails. Excess messages wait
          for the next hour. Mail is captured by Ethereal.
        </p>
      </section>
      {picker && (
        <>
          <button
            className="popover-backdrop"
            aria-label="Close scheduling options"
            onClick={() => setPicker(false)}
          />
          <section className="schedule-popover" aria-label="Send later options">
            <h3>Send Later</h3>
            <label htmlFor="start-time">Pick date & time</label>
            <input
              id="start-time"
              type="datetime-local"
              min={localDate(new Date())}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <div className="presets">
              <button
                onClick={() =>
                  setStart(localDate(new Date(Date.now() + 2 * 60000)))
                }
              >
                In 2 minutes <small>Quick demo</small>
              </button>
              {[9, 10, 11, 15].map((hour) => (
                <button
                  key={hour}
                  onClick={() => {
                    const d = new Date();
                    d.setDate(d.getDate() + 1);
                    d.setHours(hour, 0, 0, 0);
                    setStart(localDate(d));
                  }}
                >
                  Tomorrow, {hour > 12 ? hour - 12 : hour}:00{" "}
                  {hour >= 12 ? "PM" : "AM"}
                </button>
              ))}
            </div>
            <div className="popover-footer">
              <button
                className="text-button neutral"
                onClick={() => setPicker(false)}
              >
                Cancel
              </button>
              <button className="outline" onClick={() => setPicker(false)}>
                Done
              </button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
