import Papa from "papaparse";
export function parseLeads(input: string) {
  const result = Papa.parse<string[]>(input, { skipEmptyLines: true });
  const rows = result.data;
  const first = rows[0] || [];
  const emailColumn = first.findIndex((x) =>
    /^(e-?mail|email address|email_address)$/i.test(x.trim()),
  );
  const values =
    emailColumn >= 0
      ? rows.slice(1).map((row) => row[emailColumn] || "")
      : rows.flat().flatMap((x) => x.split(/[;\s]+/));
  const emails = new Set<string>();
  let duplicates = 0,
    invalid = 0;
  for (const raw of values) {
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      invalid++;
      continue;
    }
    if (emails.has(value)) duplicates++;
    else emails.add(value);
  }
  return { emails: [...emails], duplicates, invalid };
}
