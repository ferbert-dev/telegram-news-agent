# PostgreSQL contract

`postgres-17.json` is the reviewed fingerprint of the complete schema produced
by the ordered SQL migrations on a clean PostgreSQL 17 database. SQL migrations
remain authoritative; this contract makes unexpected live drift fail CI.

`npm run database:contract -- --output /tmp/postgres-contract.json` writes the
full machine-readable live inventory before comparing its section hashes. The
inventory contains schema metadata only: tables, columns, constraints, indexes,
function identities, default arguments and body checksums, policies, grants,
role memberships, and migration checksums. It does not read application rows
or credentials.

When an intentional forward migration changes the schema:

1. Create a disposable PostgreSQL 17 database and apply the ordered migrations
   twice.
2. Run `npm run database:status -- --require-applied`.
3. Run the contract command with `--output`, inspect the changed inventory, and
   obtain the new section fingerprints from the failure output.
4. Update `postgres-17.json` in the same reviewed migration change.
5. Re-run the contract command and the clean-database integration suites.

Never update a fingerprint merely to make CI green. Every changed section must
be explained by the reviewed forward migration.
