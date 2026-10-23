# Security

Tracetoon reads private material (your agent session logs) and writes to a
public place (pull requests). Its defaults:

- Only records that belong to the current repository are read into the digest;
  work from other projects in the same session is dropped.
- Secrets and personal data are redacted with the
  `@showtail/agent-traces` redactor, which also masks the real secret values
  found in your environment and credential files. Home paths and the username
  are scrubbed, and paths outside the repo become `<outside-repo>`.
- A second, independent scanner checks the final title and body. Findings
  block publishing unless you explicitly allow them.
- Nothing is posted without an approval code tied to the exact text and comic
  image you previewed (or yolo mode, which still refuses on any finding).
- Image services receive only comic scenes and character descriptions, and
  only after you consent per service.
- Log content is treated as data. The skill instructs the agent never to follow
  instructions found inside it.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
("Security" tab → "Report a vulnerability") rather than a public issue.
