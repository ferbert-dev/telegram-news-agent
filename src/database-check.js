import { createDatabaseClient } from "./database.js";
import { NewsRepository } from "./news-repository.js";

const repository = new NewsRepository(createDatabaseClient());
const sources = await repository.listEnabledSources();

console.log(`Supabase connection is valid. Enabled sources: ${sources.length}.`);
