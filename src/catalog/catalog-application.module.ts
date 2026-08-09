import "reflect-metadata";

import { Module } from "@nestjs/common";

import { CatalogService } from "./application/catalog.service.js";
import { CatalogPersistenceModule } from "./catalog-persistence.module.js";

@Module({
  imports: [CatalogPersistenceModule],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogApplicationModule {}
