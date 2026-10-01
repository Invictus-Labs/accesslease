import { z } from "zod";
import * as s from "../domain/schemas.js";

/**
 * Generates the JSON Schema files shipped in `schemas/` from the zod source of truth.
 * `npx vitest run tests/unit/backend/schemas.test.ts` fails when the committed files drift;
 * run it with `ACCESSLEASE_UPDATE_SCHEMAS=1` to rewrite them.
 */

type Defs = Record<string, z.ZodType>;

function document(name: string, title: string, io: "input" | "output", defs: Defs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(defs)) {
    const json = z.toJSONSchema(schema, { io, target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
    delete json.$schema;
    out[key] = json;
  }
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: name, title, $defs: out };
}

export function buildSchemaFiles(): Record<string, Record<string, unknown>> {
  return {
    "lease.json": document("lease.json", "AccessLease lease request and views", "output", {
      LeaseRequest: s.LeaseRequestSchema,
      Lease: s.LeaseViewSchema,
      LeaseDetail: s.LeaseDetailSchema,
      LeasePage: s.LeasePageSchema,
      ProviderLabel: s.ProviderLabelSchema,
      ProviderGrant: s.ProviderGrantSchema,
      ListQuery: s.ListQuerySchema,
    }),
    "approval.json": document("approval.json", "Approval request bound to a plan hash", "output", {
      ApproveRequest: s.ApproveRequestSchema,
    }),
    "revocation.json": document("revocation.json", "Revocation, closure and attempt records", "output", {
      RevokeRequest: s.RevokeRequestSchema,
      CloseRequest: s.CloseRequestSchema,
      RevocationAttempt: s.RevocationAttemptSchema,
      AuditEvent: s.AuditEventSchema,
    }),
    "credential.json": document("credential.json", "One-time credential delivery", "output", {
      CredentialDelivery: s.CredentialDeliverySchema,
    }),
    "policy.json": document("policy.json", "Workspace lease policy", "output", {
      Policy: s.PolicySchema,
      PolicyUpdate: s.PolicyUpdateSchema,
    }),
    "event.json": document("event.json", "Versioned event envelope (pull delivery)", "output", {
      EventEnvelope: s.EventEnvelopeSchema,
      EventPage: s.EventPageSchema,
      EventsQuery: s.EventsQuerySchema,
    }),
    "evidence-bundle.json": document("evidence-bundle.json", "Versioned evidence bundle", "output", {
      EvidenceBundle: s.EvidenceBundleSchema,
      LeaseEvidence: s.LeaseEvidenceSchema,
      BundleSummary: s.BundleSummarySchema,
      BundleVerification: s.BundleVerificationSchema,
      ImportReceipt: s.ImportReceiptSchema,
    }),
    "auth.json": document("auth.json", "Login and session", "output", {
      LoginRequest: s.LoginRequestSchema,
      Session: s.SessionSchema,
    }),
    "error.json": document("error.json", "Error envelope", "output", { Error: s.ErrorSchema, Health: s.HealthSchema }),
  };
}
