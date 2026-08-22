import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import type {
  ClaimPublicationMilestoneInput,
  MarkPublicationMilestoneFailedInput,
  MarkPublicationMilestoneSentInput,
  MarkPublicationMilestoneUncertainInput,
  PublicationMilestoneRow,
  PublicationMilestonesPersistence,
  ReconcilePublicationMilestoneSentInput,
} from "../../publication-milestones/publication-milestones.contracts.js";
import {
  mapPublicationMilestoneRow,
  type PublicationMilestoneDatabaseRow,
} from "../../publication-milestones/publication-milestones-row-mappers.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import { postgresRows, RepositorySupport } from "./repository-support.js";

const claimPublicationMilestoneFunction =
  postgresRows<PublicationMilestoneDatabaseRow>(
    "public.claim_publication_milestone",
    3,
  );
const markPublicationMilestoneSentFunction =
  postgresRows<PublicationMilestoneDatabaseRow>(
    "public.mark_publication_milestone_sent",
    3,
  );
const markPublicationMilestoneFailedFunction =
  postgresRows<PublicationMilestoneDatabaseRow>(
    "public.mark_publication_milestone_failed",
    3,
  );
const retryPublicationMilestoneFunction =
  postgresRows<PublicationMilestoneDatabaseRow>(
    "public.retry_publication_milestone",
    1,
  );
const markPublicationMilestoneUncertainFunction =
  postgresRows<PublicationMilestoneDatabaseRow>(
    "public.mark_publication_milestone_uncertain",
    3,
  );
const reconcilePublicationMilestoneSentFunction =
  postgresRows<PublicationMilestoneDatabaseRow>(
    "public.reconcile_publication_milestone_sent",
    2,
  );
const reconcilePublicationMilestoneNotSentFunction =
  postgresRows<PublicationMilestoneDatabaseRow>(
    "public.reconcile_publication_milestone_not_sent",
    1,
  );

@Injectable()
export class PublicationMilestonesRepository
  extends RepositorySupport
  implements PublicationMilestonesPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async claim({
    publicationId,
    languageCode,
    editorName,
  }: ClaimPublicationMilestoneInput): Promise<PublicationMilestoneRow | null> {
    const rows = await this.functionRows(
      "Claim publication milestone",
      claimPublicationMilestoneFunction,
      [publicationId, languageCode, editorName],
    );
    const row = this.optionalOne(rows, "Claim publication milestone");
    return row === null ? null : mapPublicationMilestoneRow(row);
  }

  async markSent({
    milestoneId,
    claimToken,
    telegramMessageId,
  }: MarkPublicationMilestoneSentInput): Promise<PublicationMilestoneRow | null> {
    const rows = await this.functionRows(
      "Mark publication milestone sent",
      markPublicationMilestoneSentFunction,
      [milestoneId, claimToken, telegramMessageId],
    );
    const row = this.optionalOne(rows, "Mark publication milestone sent");
    return row === null ? null : mapPublicationMilestoneRow(row);
  }

  async markFailed({
    milestoneId,
    claimToken,
    errorMessage,
  }: MarkPublicationMilestoneFailedInput): Promise<PublicationMilestoneRow | null> {
    const rows = await this.functionRows(
      "Mark publication milestone failed",
      markPublicationMilestoneFailedFunction,
      [milestoneId, claimToken, errorMessage],
    );
    const row = this.optionalOne(rows, "Mark publication milestone failed");
    return row === null ? null : mapPublicationMilestoneRow(row);
  }

  async retry(milestoneId: string): Promise<PublicationMilestoneRow | null> {
    const rows = await this.functionRows(
      "Retry publication milestone",
      retryPublicationMilestoneFunction,
      [milestoneId],
    );
    const row = this.optionalOne(rows, "Retry publication milestone");
    return row === null ? null : mapPublicationMilestoneRow(row);
  }

  async markUncertain({
    milestoneId,
    claimToken,
    errorMessage,
  }: MarkPublicationMilestoneUncertainInput): Promise<PublicationMilestoneRow | null> {
    const rows = await this.functionRows(
      "Mark publication milestone uncertain",
      markPublicationMilestoneUncertainFunction,
      [milestoneId, claimToken, errorMessage],
    );
    const row = this.optionalOne(rows, "Mark publication milestone uncertain");
    return row === null ? null : mapPublicationMilestoneRow(row);
  }

  async reconcileSent({
    milestoneId,
    telegramMessageId,
  }: ReconcilePublicationMilestoneSentInput): Promise<PublicationMilestoneRow | null> {
    const rows = await this.functionRows(
      "Reconcile publication milestone sent",
      reconcilePublicationMilestoneSentFunction,
      [milestoneId, telegramMessageId],
    );
    const row = this.optionalOne(rows, "Reconcile publication milestone sent");
    return row === null ? null : mapPublicationMilestoneRow(row);
  }

  async reconcileNotSent(
    milestoneId: string,
  ): Promise<PublicationMilestoneRow | null> {
    const rows = await this.functionRows(
      "Reconcile publication milestone not sent",
      reconcilePublicationMilestoneNotSentFunction,
      [milestoneId],
    );
    const row = this.optionalOne(rows, "Reconcile publication milestone not sent");
    return row === null ? null : mapPublicationMilestoneRow(row);
  }
}
