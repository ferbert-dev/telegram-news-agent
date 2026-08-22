import { Module, type DynamicModule } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { CatalogPersistenceModule } from "../catalog/catalog-persistence.module.js";
import { UsagePersistenceModule } from "../usage/usage-persistence.module.js";
import type { SourceAcquisitionClock, SourceAcquisitionDns, SourceAcquisitionTransport, SourceDiscoveryProvider } from "./source-acquisition.contracts.js";
import { SourceAcquisitionGateway } from "./source-acquisition.gateway.js";
import { SOURCE_ACQUISITION, SOURCE_ACQUISITION_CLOCK, SOURCE_ACQUISITION_DNS, SOURCE_ACQUISITION_TRANSPORT, SOURCE_DISCOVERY_PROVIDER } from "./source-acquisition.tokens.js";

@Module({})
export class SourceAcquisitionModule {
  static register(
    provider: SourceDiscoveryProvider | null,
    transport: SourceAcquisitionTransport = { fetch },
    dns: SourceAcquisitionDns = { lookup: async (hostname) => (await lookup(hostname, { all:true, verbatim:true })) as Array<{address:string;family:4|6}> },
    clock: SourceAcquisitionClock = {
      now: () => new Date(),
      sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    },
  ): DynamicModule {
    return { module: SourceAcquisitionModule, imports:[CatalogPersistenceModule, UsagePersistenceModule], providers:[
      { provide:SOURCE_ACQUISITION_TRANSPORT, useValue:transport }, { provide:SOURCE_ACQUISITION_DNS, useValue:dns }, { provide:SOURCE_ACQUISITION_CLOCK, useValue:clock }, { provide:SOURCE_DISCOVERY_PROVIDER, useValue:provider }, SourceAcquisitionGateway, { provide:SOURCE_ACQUISITION, useExisting:SourceAcquisitionGateway },
    ], exports:[SOURCE_ACQUISITION] };
  }
}
