import { timestamp } from "drizzle-orm/pg-core";

export const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "string", withTimezone: true });

export type JsonObject = Record<string, unknown>;
