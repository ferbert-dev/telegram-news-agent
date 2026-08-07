import {
  closeDatabaseClient,
  createDatabaseClient,
} from "./database.js";
import { NewsRepository } from "./news-repository.js";

const databaseClient = createDatabaseClient();
const repository = new NewsRepository(databaseClient);

try {
  const sources = await repository.listEnabledSources();
  console.log(
    `PostgreSQL connection is valid. Enabled sources: ${sources.length}.`,
  );
} finally {
  await closeDatabaseClient(databaseClient);
}
