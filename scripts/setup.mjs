import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (existsSync(".env")) {
  console.log(".env already exists; left unchanged.");
  process.exit(0);
}
writeFileSync(
  ".env",
  readFileSync(".env.example", "utf8")
    .replace(
      "replace-with-at-least-32-random-characters",
      randomBytes(32).toString("hex"),
    )
    .replace("replace-with-64-hex-characters", randomBytes(32).toString("hex")),
  { mode: 0o600 },
);
console.log(
  "Created .env with random session and encryption keys. Configure Google and Slack credentials there.",
);
