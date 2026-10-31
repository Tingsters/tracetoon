# Security

Tracetoon reads private material (your agent session logs) and writes to a
public place (pull requests). Its defaults:

- Only records that belong to the current repository are read into the digest;
  work from other projects in the same session is dropped.
- Secrets and personal data are redacted with the
  `@showtail/agent-traces` redactor, which also masks the real secret values
  found in your environment and credential files. Home paths and the username
  are scrubbed, and paths outside the repo become `<outside-repo>`.
- A PR is created only when you ask your agent for one (or the agent's own
  `gh pr create` is redirected to Tracetoon); finishing a task doesn't post
  anything.
- A second, independent scanner checks the final title and body. A possible
  secret sends the text back to be rewritten and rescanned; nothing is posted
  while it still trips, unless you explicitly say the finding is fine.
- Nothing is posted from an old render. New commits or working-tree changes
  require a fresh digest and render, and the remote branch must match the
  rendered commit (publish pushes it).
- Publishing reconciles an existing PR for the branch instead of opening a
  duplicate, and a lock stops two publications of the same run at once.
  Tracetoon never merges or force-pushes.
- Image services receive only comic scenes and character descriptions, and
  only after you consent per service.
- Log content is treated as data. The skill instructs the agent never to follow
  instructions found inside it.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
("Security" tab → "Report a vulnerability") rather than a public issue.
