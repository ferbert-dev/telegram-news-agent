# Agent Ops News Channel

Agent-operated project workspace for building a Telegram news channel bot and the delivery system around it.

## Goal

Build a minimal workflow where ideas become tickets, agents execute scoped tasks, and a Telegram bot/server publishes curated news updates to a Telegram channel.

## Current Scope

- Notion board for tickets and agent roles.
- Local project workspace for code and documentation.
- First implementation target: Telegram bot infrastructure.

## Workflow

```text
Inbox -> Ready -> In Progress -> Review -> Blocked / Done -> Archive
```

## Agent Roles

- Orchestrator: owns the goal, board, task breakdown, and agent handoffs.
- Planner: turns rough ideas into requirements and executable tickets.
- Researcher: gathers current docs, constraints, and technical options.
- Builder: implements scoped code/configuration tasks.
- Reviewer: reviews changes for defects, risks, security, and tests.
- QA: verifies behavior against acceptance criteria.
- Ops: handles deployment, environment variables, hosting, CI, and monitoring.
- Documentation: keeps README, runbooks, specs, and decisions current.

## Security Rules

- Never commit API keys, bot tokens, private keys, or secrets.
- Store runtime secrets in environment variables.
- Use `.env.example` to document required variables.
- Keep real `.env` files ignored by git.

## Notion Links

- Hub: https://app.notion.com/p/38bd78850eab810ca73de57f1fbbcc1e
- Tickets: https://app.notion.com/p/8e0e1e80d85b4f3794e859be8c2dfeee
- Agent Registry: https://app.notion.com/p/339d95a5ab0d4c4898a41382615870da
- Operating Manual: https://app.notion.com/p/38bd78850eab812f8bf1e8bbe168371d

## Next Steps

1. Choose implementation stack: Node.js or Python.
2. Decide Telegram mode: polling for local prototype or webhook for deployment.
3. Define the content source for news posts.
4. Scaffold the first bot server.
5. Add deployment and QA tickets.

