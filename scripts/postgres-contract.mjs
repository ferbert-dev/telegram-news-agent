import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { Pool } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "db", "migrations");
const contractPath = path.join(root, "db", "contracts", "postgres-17.json");
const requiredCounts = {
  tables: 23,
  foreignKeys: 23,
  functionNames: 46,
  functionSignatures: 48,
};
const protectedRoles = new Set(["PUBLIC", "anon", "authenticated"]);

function parseArguments(values) {
  let outputPath = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--output") {
      outputPath = values[index + 1];
      if (!outputPath) throw new Error("--output requires a file path");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return { outputPath };
}

const normalizeExpression = (value) =>
  value === null
    ? null
    : value
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();

const normalizeFunctionBody = (value) =>
  value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const fingerprint = (value) => sha256(`${JSON.stringify(value)}\n`);

async function localMigrations() {
  const filenames = (await readdir(migrationDirectory))
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      checksum: sha256(await readFile(path.join(migrationDirectory, filename))),
    })),
  );
}

async function inventoryDatabase(pool) {
  const [
    versionResult,
    tableResult,
    columnResult,
    constraintResult,
    indexResult,
    functionResult,
    policyResult,
    tableGrantResult,
    functionGrantResult,
    schemaGrantResult,
    roleMembershipResult,
    migrationResult,
  ] = await Promise.all([
    pool.query(`
      select
        current_setting('server_version') as version,
        current_setting('server_version_num')::integer as version_number
    `),
    pool.query(`
      select
        relation.relname as name,
        pg_get_userbyid(relation.relowner) as owner,
        relation.relrowsecurity as rls_enabled,
        relation.relforcerowsecurity as rls_forced
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
      order by relation.relname
    `),
    pool.query(`
      select
        relation.relname as table_name,
        attribute.attnum as position,
        attribute.attname as name,
        format_type(attribute.atttypid, attribute.atttypmod) as data_type,
        not attribute.attnotnull as nullable,
        pg_get_expr(default_value.adbin, default_value.adrelid, true) as default_expression,
        attribute.attidentity as identity_kind,
        attribute.attgenerated as generated_kind
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation.oid
      left join pg_catalog.pg_attrdef as default_value
        on default_value.adrelid = relation.oid
        and default_value.adnum = attribute.attnum
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by relation.relname, attribute.attnum
    `),
    pool.query(`
      select
        source_table.relname as table_name,
        constraint_value.conname as name,
        constraint_value.contype as type,
        pg_get_constraintdef(constraint_value.oid, true) as definition,
        constraint_value.condeferrable as deferrable,
        constraint_value.condeferred as initially_deferred,
        constraint_value.convalidated as validated,
        target_table.relname as referenced_table
      from pg_catalog.pg_constraint as constraint_value
      join pg_catalog.pg_class as source_table
        on source_table.oid = constraint_value.conrelid
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = source_table.relnamespace
      left join pg_catalog.pg_class as target_table
        on target_table.oid = constraint_value.confrelid
      where namespace.nspname = 'public'
        and constraint_value.contype in ('p', 'u', 'c', 'f')
      order by source_table.relname, constraint_value.conname
    `),
    pool.query(`
      select
        source_table.relname as table_name,
        index_relation.relname as name,
        access_method.amname as access_method,
        index_value.indisprimary as primary,
        index_value.indisunique as unique,
        index_value.indisvalid as valid,
        index_value.indisready as ready,
        constraint_value.oid is not null as constraint_backed,
        pg_get_indexdef(index_value.indexrelid) as definition,
        pg_get_expr(index_value.indpred, index_value.indrelid, true) as predicate
      from pg_catalog.pg_index as index_value
      join pg_catalog.pg_class as source_table
        on source_table.oid = index_value.indrelid
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = source_table.relnamespace
      join pg_catalog.pg_class as index_relation
        on index_relation.oid = index_value.indexrelid
      join pg_catalog.pg_am as access_method
        on access_method.oid = index_relation.relam
      left join pg_catalog.pg_constraint as constraint_value
        on constraint_value.conindid = index_value.indexrelid
      where namespace.nspname = 'public'
      order by source_table.relname, index_relation.relname
    `),
    pool.query(`
      select
        function_value.proname as name,
        pg_get_function_identity_arguments(function_value.oid) as identity_arguments,
        pg_get_function_arguments(function_value.oid) as arguments,
        function_value.pronargdefaults as default_argument_count,
        pg_get_function_result(function_value.oid) as result_type,
        language.lanname as language,
        function_value.provolatile as volatility,
        function_value.prosecdef as security_definer,
        function_value.proleakproof as leakproof,
        function_value.proisstrict as strict,
        function_value.proparallel as parallel_safety,
        coalesce(function_value.proconfig, '{}'::text[]) as configuration,
        function_value.prosrc as body
      from pg_catalog.pg_proc as function_value
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = function_value.pronamespace
      join pg_catalog.pg_language as language
        on language.oid = function_value.prolang
      where namespace.nspname = 'public'
        and function_value.prokind = 'f'
      order by function_value.proname, pg_get_function_identity_arguments(function_value.oid)
    `),
    pool.query(`
      select
        schemaname as schema_name,
        tablename as table_name,
        policyname as name,
        permissive,
        roles,
        cmd as command,
        qual as using_expression,
        with_check as check_expression
      from pg_catalog.pg_policies
      where schemaname = 'public'
      order by tablename, policyname
    `),
    pool.query(`
      select
        relation.relname as object_name,
        pg_get_userbyid(grant_value.grantor) as grantor,
        case grant_value.grantee
          when 0 then 'PUBLIC'
          else pg_get_userbyid(grant_value.grantee)
        end as grantee,
        grant_value.privilege_type,
        grant_value.is_grantable
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      cross join lateral aclexplode(
        coalesce(relation.relacl, acldefault('r', relation.relowner))
      ) as grant_value
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
      order by relation.relname, grantee, grant_value.privilege_type
    `),
    pool.query(`
      select
        function_value.proname as object_name,
        pg_get_function_identity_arguments(function_value.oid) as identity_arguments,
        pg_get_userbyid(grant_value.grantor) as grantor,
        case grant_value.grantee
          when 0 then 'PUBLIC'
          else pg_get_userbyid(grant_value.grantee)
        end as grantee,
        grant_value.privilege_type,
        grant_value.is_grantable
      from pg_catalog.pg_proc as function_value
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = function_value.pronamespace
      cross join lateral aclexplode(
        coalesce(function_value.proacl, acldefault('f', function_value.proowner))
      ) as grant_value
      where namespace.nspname = 'public'
        and function_value.prokind = 'f'
      order by
        function_value.proname,
        pg_get_function_identity_arguments(function_value.oid),
        grantee,
        grant_value.privilege_type
    `),
    pool.query(`
      select
        namespace.nspname as object_name,
        pg_get_userbyid(grant_value.grantor) as grantor,
        case grant_value.grantee
          when 0 then 'PUBLIC'
          else pg_get_userbyid(grant_value.grantee)
        end as grantee,
        grant_value.privilege_type,
        grant_value.is_grantable
      from pg_catalog.pg_namespace as namespace
      cross join lateral aclexplode(
        coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) as grant_value
      where namespace.nspname = 'public'
      order by grantee, grant_value.privilege_type
    `),
    pool.query(`
      select
        member_role.rolname as member,
        granted_role.rolname as role
      from pg_catalog.pg_auth_members as membership
      join pg_catalog.pg_roles as member_role
        on member_role.oid = membership.member
      join pg_catalog.pg_roles as granted_role
        on granted_role.oid = membership.roleid
      where member_role.rolname in ('telegram_news_app', 'anon', 'authenticated', 'service_role')
        or granted_role.rolname in ('telegram_news_app', 'anon', 'authenticated', 'service_role')
      order by member_role.rolname, granted_role.rolname
    `),
    pool.query(`
      select filename, checksum
      from public.schema_migrations
      order by filename
    `),
  ]);

  const version = versionResult.rows[0];
  const functions = functionResult.rows.map((row) => ({
    name: row.name,
    identityArguments: row.identity_arguments,
    arguments: normalizeExpression(row.arguments),
    defaultArgumentCount: row.default_argument_count,
    resultType: row.result_type,
    language: row.language,
    volatility: { i: "immutable", s: "stable", v: "volatile" }[row.volatility],
    security: row.security_definer ? "definer" : "invoker",
    leakproof: row.leakproof,
    strict: row.strict,
    parallelSafety: { s: "safe", r: "restricted", u: "unsafe" }[
      row.parallel_safety
    ],
    configuration: [...row.configuration].sort(),
    bodySha256: sha256(normalizeFunctionBody(row.body)),
  }));

  return {
    contractVersion: 1,
    postgresql: {
      major: Math.floor(version.version_number / 10_000),
      version: version.version,
    },
    tables: tableResult.rows.map((row) => ({
      name: row.name,
      owner: row.owner,
      rlsEnabled: row.rls_enabled,
      rlsForced: row.rls_forced,
    })),
    columns: columnResult.rows.map((row) => ({
      table: row.table_name,
      position: row.position,
      name: row.name,
      type: row.data_type,
      nullable: row.nullable,
      default: normalizeExpression(row.default_expression),
      identity: row.identity_kind || null,
      generated: row.generated_kind || null,
    })),
    constraints: constraintResult.rows.map((row) => ({
      table: row.table_name,
      name: row.name,
      type: { p: "primary", u: "unique", c: "check", f: "foreign" }[
        row.type
      ],
      definition: normalizeExpression(row.definition),
      referencedTable: row.referenced_table,
      deferrable: row.deferrable,
      initiallyDeferred: row.initially_deferred,
      validated: row.validated,
    })),
    indexes: indexResult.rows.map((row) => ({
      table: row.table_name,
      name: row.name,
      accessMethod: row.access_method,
      primary: row.primary,
      unique: row.unique,
      valid: row.valid,
      ready: row.ready,
      constraintBacked: row.constraint_backed,
      definition: normalizeExpression(row.definition),
      predicate: normalizeExpression(row.predicate),
    })),
    functions,
    policies: policyResult.rows.map((row) => ({
      schema: row.schema_name,
      table: row.table_name,
      name: row.name,
      permissive: row.permissive,
      roles: [...row.roles].sort(),
      command: row.command,
      using: normalizeExpression(row.using_expression),
      check: normalizeExpression(row.check_expression),
    })),
    grants: {
      tables: tableGrantResult.rows.map((row) => ({
        object: row.object_name,
        grantor: row.grantor,
        grantee: row.grantee,
        privilege: row.privilege_type,
        grantable: row.is_grantable,
      })),
      functions: functionGrantResult.rows.map((row) => ({
        object: row.object_name,
        identityArguments: row.identity_arguments,
        grantor: row.grantor,
        grantee: row.grantee,
        privilege: row.privilege_type,
        grantable: row.is_grantable,
      })),
      schemas: schemaGrantResult.rows.map((row) => ({
        object: row.object_name,
        grantor: row.grantor,
        grantee: row.grantee,
        privilege: row.privilege_type,
        grantable: row.is_grantable,
      })),
      roleMemberships: roleMembershipResult.rows,
    },
    migrations: migrationResult.rows,
  };
}

function assertInvariants(inventory, migrations) {
  const errors = [];
  const foreignKeyCount = inventory.constraints.filter(
    (constraint) => constraint.type === "foreign",
  ).length;
  const functionNames = new Set(
    inventory.functions.map((functionValue) => functionValue.name),
  );
  const actualCounts = {
    tables: inventory.tables.length,
    foreignKeys: foreignKeyCount,
    functionNames: functionNames.size,
    functionSignatures: inventory.functions.length,
  };

  for (const [name, expected] of Object.entries(requiredCounts)) {
    if (actualCounts[name] !== expected) {
      errors.push(`${name}: expected ${expected}, received ${actualCounts[name]}`);
    }
  }
  if (inventory.postgresql.major !== 17) {
    errors.push(
      `postgresql major: expected 17, received ${inventory.postgresql.major}`,
    );
  }

  const tablesWithoutRls = inventory.tables
    .filter((table) => table.name !== "schema_migrations" && !table.rlsEnabled)
    .map((table) => table.name);
  if (tablesWithoutRls.length > 0) {
    errors.push(`application tables without RLS: ${tablesWithoutRls.join(", ")}`);
  }

  const functionsWithoutSearchPath = inventory.functions
    .filter(
      (functionValue) =>
        !functionValue.configuration.some((entry) =>
          entry.startsWith("search_path="),
        ),
    )
    .map(
      (functionValue) =>
        `${functionValue.name}(${functionValue.identityArguments})`,
    );
  if (functionsWithoutSearchPath.length > 0) {
    errors.push(
      `functions without configured search_path: ${functionsWithoutSearchPath.join(", ")}`,
    );
  }

  const unsafeTableGrants = inventory.grants.tables.filter((grant) =>
    protectedRoles.has(grant.grantee),
  );
  const unsafeFunctionGrants = inventory.grants.functions.filter((grant) =>
    protectedRoles.has(grant.grantee),
  );
  if (unsafeTableGrants.length > 0) {
    errors.push(
      `untrusted table grants: ${unsafeTableGrants
        .map((grant) => `${grant.grantee}:${grant.object}:${grant.privilege}`)
        .join(", ")}`,
    );
  }
  if (unsafeFunctionGrants.length > 0) {
    errors.push(
      `untrusted function grants: ${unsafeFunctionGrants
        .map(
          (grant) =>
            `${grant.grantee}:${grant.object}(${grant.identityArguments}):${grant.privilege}`,
        )
        .join(", ")}`,
    );
  }

  if (!isDeepStrictEqual(inventory.migrations, migrations)) {
    errors.push("applied migrations do not exactly match ordered local migrations");
  }

  if (errors.length > 0) {
    throw new Error(`PostgreSQL contract invariants failed:\n- ${errors.join("\n- ")}`);
  }

  return actualCounts;
}

function sectionHashes(inventory) {
  return Object.fromEntries(
    [
      "tables",
      "columns",
      "constraints",
      "indexes",
      "functions",
      "policies",
      "grants",
      "migrations",
    ].map((section) => [section, fingerprint(inventory[section])]),
  );
}

const { outputPath } = parseArguments(process.argv.slice(2));
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 1 });

try {
  const migrations = await localMigrations();
  const inventory = await inventoryDatabase(pool);
  const counts = assertInvariants(inventory, migrations);
  const actualContract = {
    contractVersion: inventory.contractVersion,
    postgresqlMajor: inventory.postgresql.major,
    requiredCounts,
    sectionHashes: sectionHashes(inventory),
  };

  if (outputPath) {
    const resolvedOutput = path.resolve(outputPath);
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    await writeFile(resolvedOutput, `${JSON.stringify(inventory, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  const expectedContract = JSON.parse(await readFile(contractPath, "utf8"));
  if (!isDeepStrictEqual(actualContract, expectedContract)) {
    const mismatches = Object.keys(actualContract.sectionHashes).filter(
      (section) =>
        actualContract.sectionHashes[section] !==
        expectedContract.sectionHashes?.[section],
    );
    throw new Error(
      [
        "PostgreSQL live inventory differs from db/contracts/postgres-17.json.",
        mismatches.length > 0
          ? `Changed sections: ${mismatches.join(", ")}`
          : "Contract metadata differs.",
        `Actual contract: ${JSON.stringify(actualContract)}.`,
        "Inspect the machine-readable inventory before updating the reviewed contract.",
      ].join(" "),
    );
  }

  console.log(
    JSON.stringify({
      event: "postgres_contract_verified",
      postgresqlMajor: inventory.postgresql.major,
      ...counts,
      policies: inventory.policies.length,
      migrations: inventory.migrations.length,
      inventoryOutput: outputPath ? path.resolve(outputPath) : null,
    }),
  );
} finally {
  await pool.end();
}
