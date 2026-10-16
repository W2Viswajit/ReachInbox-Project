import { LoaderCircle, Clock } from "lucide-react";
import type { User, Email } from "./api";
export const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
export const localDate = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
export const plain = (html: string) => {
  const d = new DOMParser().parseFromString(html, "text/html");
  return d.body.textContent || "";
};
export function Spinner() {
  return <LoaderCircle className="spin" size={18} />;
}
export function Avatar({ user }: { user: User }) {
  return user.avatar ? (
    <img
      className="avatar"
      src={user.avatar}
      alt=""
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className="avatar initials">{user.name.charAt(0)}</span>
  );
}
export function Badge({ email }: { email: Email }) {
  return (
    <span className={`badge ${email.status}`}>
      {["scheduled", "deferred"].includes(email.status) && <Clock size={12} />}{" "}
      {email.status === "scheduled"
        ? date(email.scheduled_at)
        : email.status === "deferred"
          ? "Deferred"
          : email.status === "uncertain"
            ? "Needs review"
            : email.status.charAt(0).toUpperCase() + email.status.slice(1)}
    </span>
  );
}
