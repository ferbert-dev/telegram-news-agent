# Agent Run fallback outbox

Notion `Agent Runs` is the canonical audit log. Use this folder only when Notion is temporarily unavailable.

Create `agents/runs/pending/<UTC timestamp>-<role>-<slug>.md` with:

```markdown
# Run name

- Ticket URL:
- Agent Registry URL:
- Role:
- Started At:
- Finished At:
- Status: Running | Succeeded | Failed | Blocked | Cancelled
- Objective:
- Result:
- Evidence:
- Error or blocker:
```

Rules:

- Never include secrets, credentials, private keys, database URLs, or raw provider payloads.
- Backfill the entry into Notion and remove the pending file before the ticket becomes `Done`.
- This is recovery state, not a second permanent activity log.
