# Read-only PostgreSQL access through SSH

## Security model

PostgreSQL must not be exposed through an Oracle Cloud ingress rule. Production
publishes the container port only on the VM loopback interface:

```text
local DBeaver
  -> encrypted SSH connection on TCP 22
  -> Oracle VM 127.0.0.1:55432
  -> PostgreSQL container db:5432
```

Traffic from the internet cannot connect directly to `55432`. Do not add Oracle
Security List or Network Security Group ingress for `5432` or `55432`.

The observer account is separate from both the PostgreSQL superuser and the bot
application account. It has `SELECT` access, a two-connection limit, a
30-second statement timeout, and read-only transactions. It bypasses RLS only
so the project owner can inspect every application row; it has no table write
grants and no role-administration privileges.
It also receives no function execution grants; functions can be inspected as
schema objects but must not be invoked from this diagnostic account.

## One-time observer setup

After the deployment containing `compose.ssh-access.yaml` is complete, connect
to the Oracle instance:

```bash
ssh ubuntu@<ORACLE_HOST>
cd /opt/telegram-news-agent
./ops/configure-db-observer.sh
```

The script generates and displays a new 48-character password once. Store it in
DBeaver's secure password storage. Running the script again rotates the same
observer account password without changing application credentials.

The default loopback port is `55432`. It can be changed by adding this value to
`.env.production` before deployment:

```dotenv
POSTGRES_SSH_TUNNEL_PORT=55432
```

## DBeaver connection

Create a new PostgreSQL connection and enter these values on the **Main** tab:

| Setting | Value |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `55432` |
| Database | `telegram_news` |
| Username | `telegram_news_observer` |
| Password | generated observer password |

Then enable the **SSH** network configuration:

| Setting | Value |
| --- | --- |
| Host/IP | Oracle public IP or `ORACLE_HOST` |
| Port | `22` |
| User | normally `ubuntu` |
| Authentication | Public key |
| Private key | the local private key authorized on this Oracle VM |

DBeaver normally selects a temporary local forwarding port automatically. The
Main-tab host and port are the destination as seen from the Oracle VM. Test the
SSH tunnel first, then test the PostgreSQL connection.

An equivalent manual tunnel is:

```bash
ssh -N -L 55432:127.0.0.1:55432 ubuntu@<ORACLE_HOST>
```

Keep that terminal open and configure DBeaver without its built-in SSH handler,
using `127.0.0.1:55432` on the Main tab.

## What to inspect

In DBeaver, open:

```text
telegram_news
  -> Databases
  -> telegram_news
  -> Schemas
  -> public
      -> Tables
      -> Views
      -> Functions
      -> Sequences
```

Useful read-only queries:

```sql
select tablename
from pg_catalog.pg_tables
where schemaname = 'public'
order by tablename;

select
  procedure.proname as function_name,
  pg_get_function_identity_arguments(procedure.oid) as arguments,
  pg_get_function_result(procedure.oid) as result,
  procedure.prosecdef as security_definer
from pg_catalog.pg_proc as procedure
join pg_catalog.pg_namespace as namespace
  on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
order by procedure.proname, arguments;

select filename, checksum, applied_at
from public.schema_migrations
order by filename;

select id, name, source_type, enabled, consecutive_failures, disabled_until
from public.sources
order by name
limit 100;
```

The observer is intended for exploration and diagnostics. Schema changes still
go through checked-in SQL migrations and CI, never through DBeaver's table
editor.
