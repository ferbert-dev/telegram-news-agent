import { getTableConfig } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import { databaseTables } from "../src/database/schema/registry.js";

type ExpectedColumn = {
  name: string;
  nullable: boolean;
  type: string;
};

type ActualColumnRow = {
  table_name: string;
  column_name: string;
  nullable: boolean;
  data_type: string;
  row_level_security: boolean;
};

type ActualForeignKeyRow = {
  table_name: string;
  foreign_table_name: string;
  columns: string[];
  foreign_columns: string[];
  on_delete: string;
  on_update: string;
};

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const normalizeType = (value: string) =>
  value.toLowerCase().replace(/,\s+/g, ",").replace(/\s+/g, " ").trim();

const actionName = (action: string | undefined) => action ?? "no action";

const expectedTables = new Map(
  databaseTables.map((table) => {
    const config = getTableConfig(table);
    return [
      config.name,
      {
        columns: new Map<string, ExpectedColumn>(
          config.columns.map((column) => [
            column.name,
            {
              name: column.name,
              nullable: !column.notNull,
              type: normalizeType(column.getSQLType()),
            },
          ]),
        ),
        foreignKeys: config.foreignKeys.map((foreignKey) => {
          const reference = foreignKey.reference();
          return {
            columns: reference.columns.map((column) => column.name),
            foreignColumns: reference.foreignColumns.map((column) => column.name),
            foreignTable: getTableConfig(reference.foreignTable).name,
            onDelete: actionName(foreignKey.onDelete),
            onUpdate: actionName(foreignKey.onUpdate),
          };
        }),
        indexes: config.indexes.flatMap((entry) =>
          entry.config.name ? [entry.config.name] : [],
        ),
        rowLevelSecurity: config.enableRLS,
      },
    ] as const;
  }),
);

const foreignKeySignature = (foreignKey: {
  columns: string[];
  foreignColumns: string[];
  foreignTable: string;
  onDelete: string;
  onUpdate: string;
}) =>
  `${foreignKey.columns.join(",")}->${foreignKey.foreignTable}(${foreignKey.foreignColumns.join(",")}) delete ${foreignKey.onDelete} update ${foreignKey.onUpdate}`;

const pool = new Pool({ connectionString, max: 1 });

try {
  const [columnResult, foreignKeyResult, indexResult] = await Promise.all([
    pool.query<ActualColumnRow>(`
      select
        relation.relname as table_name,
        attribute.attname as column_name,
        not attribute.attnotnull as nullable,
        format_type(attribute.atttypid, attribute.atttypmod) as data_type,
        relation.relrowsecurity as row_level_security
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation.oid
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by relation.relname, attribute.attnum
    `),
    pool.query<ActualForeignKeyRow>(`
      select
        source_table.relname as table_name,
        target_table.relname as foreign_table_name,
        array_agg(source_attribute.attname::text order by key_position.ordinality) as columns,
        array_agg(target_attribute.attname::text order by key_position.ordinality) as foreign_columns,
        case foreign_key.confdeltype
          when 'a' then 'no action'
          when 'r' then 'restrict'
          when 'c' then 'cascade'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as on_delete,
        case foreign_key.confupdtype
          when 'a' then 'no action'
          when 'r' then 'restrict'
          when 'c' then 'cascade'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as on_update
      from pg_catalog.pg_constraint as foreign_key
      join pg_catalog.pg_class as source_table
        on source_table.oid = foreign_key.conrelid
      join pg_catalog.pg_namespace as source_namespace
        on source_namespace.oid = source_table.relnamespace
      join pg_catalog.pg_class as target_table
        on target_table.oid = foreign_key.confrelid
      join lateral unnest(foreign_key.conkey, foreign_key.confkey)
        with ordinality as key_position(source_number, target_number, ordinality)
        on true
      join pg_catalog.pg_attribute as source_attribute
        on source_attribute.attrelid = source_table.oid
        and source_attribute.attnum = key_position.source_number
      join pg_catalog.pg_attribute as target_attribute
        on target_attribute.attrelid = target_table.oid
        and target_attribute.attnum = key_position.target_number
      where foreign_key.contype = 'f'
        and source_namespace.nspname = 'public'
      group by
        source_table.relname,
        target_table.relname,
        foreign_key.oid,
        foreign_key.confdeltype,
        foreign_key.confupdtype
      order by source_table.relname, foreign_key.oid
    `),
    pool.query<{ indexname: string }>(`
      select indexname
      from pg_catalog.pg_indexes
      where schemaname = 'public'
      order by indexname
    `),
  ]);

  const actualTables = new Map<
    string,
    { columns: Map<string, ActualColumnRow>; rowLevelSecurity: boolean }
  >();
  for (const row of columnResult.rows) {
    const table = actualTables.get(row.table_name) ?? {
      columns: new Map(),
      rowLevelSecurity: row.row_level_security,
    };
    table.columns.set(row.column_name, row);
    actualTables.set(row.table_name, table);
  }

  const errors: string[] = [];
  for (const tableName of expectedTables.keys()) {
    if (!actualTables.has(tableName)) {
      errors.push(`missing table: public.${tableName}`);
    }
  }
  for (const tableName of actualTables.keys()) {
    if (!expectedTables.has(tableName)) {
      errors.push(`table is not declared in Drizzle: public.${tableName}`);
    }
  }

  for (const [tableName, expected] of expectedTables) {
    const actual = actualTables.get(tableName);
    if (!actual) continue;

    if (expected.rowLevelSecurity !== actual.rowLevelSecurity) {
      errors.push(
        `RLS mismatch: public.${tableName} expected=${expected.rowLevelSecurity} actual=${actual.rowLevelSecurity}`,
      );
    }

    for (const [columnName, expectedColumn] of expected.columns) {
      const actualColumn = actual.columns.get(columnName);
      if (!actualColumn) {
        errors.push(`missing column: public.${tableName}.${columnName}`);
        continue;
      }
      const actualType = normalizeType(actualColumn.data_type);
      if (expectedColumn.type !== actualType) {
        errors.push(
          `type mismatch: public.${tableName}.${columnName} expected=${expectedColumn.type} actual=${actualType}`,
        );
      }
      if (expectedColumn.nullable !== actualColumn.nullable) {
        errors.push(
          `nullability mismatch: public.${tableName}.${columnName} expected=${expectedColumn.nullable} actual=${actualColumn.nullable}`,
        );
      }
    }
    for (const columnName of actual.columns.keys()) {
      if (!expected.columns.has(columnName)) {
        errors.push(`column is not declared in Drizzle: public.${tableName}.${columnName}`);
      }
    }
  }

  const actualForeignKeys = new Map<string, Set<string>>();
  for (const row of foreignKeyResult.rows) {
    const signatures = actualForeignKeys.get(row.table_name) ?? new Set<string>();
    signatures.add(
      foreignKeySignature({
        columns: row.columns,
        foreignColumns: row.foreign_columns,
        foreignTable: row.foreign_table_name,
        onDelete: row.on_delete,
        onUpdate: row.on_update,
      }),
    );
    actualForeignKeys.set(row.table_name, signatures);
  }

  for (const [tableName, expected] of expectedTables) {
    const expectedSignatures = new Set(
      expected.foreignKeys.map(foreignKeySignature),
    );
    const actualSignatures = actualForeignKeys.get(tableName) ?? new Set<string>();
    for (const signature of expectedSignatures) {
      if (!actualSignatures.has(signature)) {
        errors.push(`missing foreign key: public.${tableName} ${signature}`);
      }
    }
    for (const signature of actualSignatures) {
      if (!expectedSignatures.has(signature)) {
        errors.push(`foreign key is not declared in Drizzle: public.${tableName} ${signature}`);
      }
    }
  }

  const actualIndexes = new Set(indexResult.rows.map((row) => row.indexname));
  for (const [tableName, expected] of expectedTables) {
    for (const indexName of expected.indexes) {
      if (!actualIndexes.has(indexName)) {
        errors.push(`missing index: public.${indexName} (table ${tableName})`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("Database schema differs from the Drizzle snapshot:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify({
        event: "schema_drift_check_passed",
        foreignKeys: foreignKeyResult.rows.length,
        tables: expectedTables.size,
      }),
    );
  }
} finally {
  await pool.end();
}
