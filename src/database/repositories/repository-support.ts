import { sql, type SQL } from "drizzle-orm";
import type { QueryResultRow } from "pg";

import type { DrizzleDatabase } from "../drizzle-client.js";

type DrizzleTransaction = Parameters<
  Parameters<DrizzleDatabase["transaction"]>[0]
>[0];

type DrizzleExecutor = DrizzleDatabase | DrizzleTransaction;

const POSTGRES_FUNCTION_IDENTIFIER = /^public\.[a-z][a-z0-9_]*$/;

type FunctionResultKind = "rows" | "scalar";

export type PostgresFunction<TResult> = Readonly<{
  identifier: `public.${string}`;
  parameterCount: number;
  resultKind: FunctionResultKind;
  readonly result?: TResult;
}>;

function definePostgresFunction<TResult>(
  identifier: `public.${string}`,
  parameterCount: number,
  resultKind: FunctionResultKind,
): PostgresFunction<TResult> {
  if (!POSTGRES_FUNCTION_IDENTIFIER.test(identifier)) {
    throw new Error(`Invalid PostgreSQL function identifier: ${identifier}`);
  }
  if (!Number.isInteger(parameterCount) || parameterCount < 0) {
    throw new Error("PostgreSQL function parameter count must be non-negative");
  }
  return Object.freeze({ identifier, parameterCount, resultKind });
}

export function postgresRows<TResult extends QueryResultRow>(
  identifier: `public.${string}`,
  parameterCount: number,
): PostgresFunction<TResult> {
  return definePostgresFunction(identifier, parameterCount, "rows");
}

export function postgresScalar<TResult>(
  identifier: `public.${string}`,
  parameterCount: number,
): PostgresFunction<{ value: TResult }> {
  return definePostgresFunction(identifier, parameterCount, "scalar");
}

function functionQuery<TResult>(
  definition: PostgresFunction<TResult>,
  parameters: readonly unknown[],
): SQL {
  if (parameters.length !== definition.parameterCount) {
    throw new Error(
      `${definition.identifier} expects ${definition.parameterCount} parameters, received ${parameters.length}`,
    );
  }

  const [schemaName, functionName] = definition.identifier.split(".");
  const argumentsSql = sql.join(
    parameters.map((parameter) => sql`${sql.param(parameter)}`),
    sql`, `,
  );
  const call = sql`${sql.identifier(schemaName)}.${sql.identifier(functionName)}(${argumentsSql})`;

  return definition.resultKind === "rows"
    ? sql`select * from ${call}`
    : sql`select ${call} as value`;
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function toIsoTimestamp(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid PostgreSQL timestamp");
  }
  return parsed.toISOString();
}

export function toNullableIsoTimestamp(
  value: string | Date | null,
): string | null {
  return value === null ? null : toIsoTimestamp(value);
}

function errorMessage(error: unknown): string {
  let current = error;
  while (
    current instanceof Error &&
    current.cause instanceof Error &&
    current.cause !== current
  ) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
}

export abstract class RepositorySupport {
  readonly database: DrizzleDatabase;

  protected constructor(
    protected readonly pool: import("pg").Pool,
    database: DrizzleDatabase,
  ) {
    if (!pool?.query) {
      throw new Error("A PostgreSQL pool is required");
    }
    if (!database?.execute || !database?.transaction) {
      throw new Error("A shared Drizzle database is required");
    }
    this.database = database;
  }

  protected async operation<T>(
    name: string,
    task: () => Promise<T>,
  ): Promise<T> {
    try {
      return await task();
    } catch (error) {
      throw new Error(`${name} failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  protected one<T>(rows: T[], operation: string): T {
    if (rows.length !== 1) {
      throw new Error(
        `${operation} failed: expected one row, received ${rows.length}`,
      );
    }
    return rows[0];
  }

  protected optionalOne<T>(rows: T[], operation: string): T | null {
    if (rows.length > 1) {
      throw new Error(`${operation} failed: expected at most one row`);
    }
    return rows[0] ?? null;
  }

  protected async functionRows<T extends QueryResultRow>(
    operation: string,
    definition: PostgresFunction<T>,
    parameters: readonly unknown[],
    executor: DrizzleExecutor = this.database,
  ): Promise<T[]> {
    const result = await this.operation(operation, () =>
      executor.execute(functionQuery(definition, parameters)),
    );
    return result.rows as T[];
  }

  protected async functionScalar<T>(
    operation: string,
    definition: PostgresFunction<{ value: T }>,
    parameters: readonly unknown[],
    executor: DrizzleExecutor = this.database,
  ): Promise<T> {
    const rows = await this.functionRows(
      operation,
      definition,
      parameters,
      executor,
    );
    return this.one(rows, operation).value;
  }

  protected transaction<T>(
    operation: string,
    task: (executor: DrizzleTransaction) => Promise<T>,
  ): Promise<T> {
    return this.operation(operation, () => this.database.transaction(task));
  }
}
