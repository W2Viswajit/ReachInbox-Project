import { config } from "./config.js";
import { db } from "./db.js";
const base = config.ELASTICSEARCH_URL.replace(/\/$/, "");
export async function elastic(path: string, method = "GET", body?: unknown) {
  const r = await fetch(`${base}/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const json = (await r.json()) as any;
  if (!r.ok)
    throw Object.assign(new Error("Search service unavailable"), {
      status: r.status,
      details: json,
    });
  return json;
}
export async function initSearch() {
  try {
    await elastic("reachinbox-emails", "PUT", {
      mappings: {
        properties: {
          user_id: { type: "keyword" },
          status: { type: "keyword" },
          sender_id: { type: "keyword" },
          recipient: { type: "text", fields: { keyword: { type: "keyword" } } },
          subject: { type: "text" },
          body: { type: "text" },
          scheduled_at: { type: "date" },
          sent_at: { type: "date" },
        },
      },
    });
  } catch (e: any) {
    if (e.details?.error?.type !== "resource_already_exists_exception") throw e;
  }
}
export async function indexPending() {
  const { rows } = await db.query(
    "SELECT * FROM emails WHERE indexed_version<version ORDER BY created_at LIMIT 100",
  );
  for (const row of rows) {
    const document = {
      user_id: row.user_id,
      sender_id: row.sender_id,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body.replace(/<[^>]+>/g, " "),
      status: row.status,
      scheduled_at: row.scheduled_at,
      sent_at: row.sent_at,
    };
    try {
      await elastic(
        `reachinbox-emails/_doc/${row.id}?version=${row.version}&version_type=external_gte`,
        "PUT",
        document,
      );
    } catch (e: any) {
      if (e.status !== 409) throw e;
    }
    await db.query(
      "UPDATE emails SET indexed_version=GREATEST(indexed_version,$2) WHERE id=$1",
      [row.id, row.version],
    );
  }
}
export async function searchEmails(
  userId: string,
  text: string,
  statuses: string[],
  page: number,
) {
  return elastic("reachinbox-emails/_search", "POST", {
    from: (page - 1) * 25,
    size: 25,
    track_total_hits: true,
    query: {
      bool: {
        filter: [
          { term: { user_id: userId } },
          { terms: { status: statuses } },
        ],
        must: [
          {
            multi_match: {
              query: text,
              fields: ["recipient^3", "subject^2", "body"],
              type: "best_fields",
              operator: "and",
            },
          },
        ],
      },
    },
    sort: [{ scheduled_at: "desc" }],
  });
}
