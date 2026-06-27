import { createClient } from "@supabase/supabase-js";

export function getDatabaseConfig(env = process.env) {
  const url = env.SUPABASE_URL?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();

  if (!url) {
    throw new Error("SUPABASE_URL is required");
  }

  if (!secretKey) {
    throw new Error("SUPABASE_SECRET_KEY is required");
  }

  return { url, secretKey };
}

export function createDatabaseClient(config = getDatabaseConfig()) {
  return createClient(config.url, config.secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function requireResult(result, operation) {
  if (result.error) {
    throw new Error(`${operation} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }

  return result.data;
}
