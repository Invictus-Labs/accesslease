import { describe } from "vitest";
import { scopeAndTtlPolicy } from "./ac/ac01-scope-ttl.js";
import { approvalFreshness } from "./ac/ac02-approval.js";
import { nativeTtlAndIssueAmbiguity } from "./ac/ac03-native-ttl.js";
import { expiryAndClosure } from "./ac/ac04-expiry-closure.js";
import { revocationOutage } from "./ac/ac05-outage.js";
import { restartSweep } from "./ac/ac06-restart-sweep.js";
import { realDenialProof } from "./ac/ac07-live-denial.js";
import { offlineDemo } from "./ac/ac08-offline.js";
import { redactionAndHostileInput } from "./ac/ac09-redaction-hostile.js";
import { portabilityAndCorruption } from "./ac/ac10-portability.js";
import { workspaceIsolation } from "./ac/ac12-isolation.js";
import { restartAndRestore } from "./ac/ac13-restart-restore.js";

/**
 * Acceptance matrix (docs/prd/accesslease.md section 5b). One describe block per row; the block titles are the "Proven by" test
 * identifiers: `tests/accesslease.spec.ts :: <title>`. The bodies live in tests/ac/ so each row stays readable. AC-11 is human-only
 * and has no automated pass: see docs/qa/ac-11-human-drill.md.
 */
describe("scope and TTL policy", scopeAndTtlPolicy); // AC-01
describe("approval freshness", approvalFreshness); // AC-02
describe("native TTL and issue ambiguity", nativeTtlAndIssueAmbiguity); // AC-03
describe("expiry and closure", expiryAndClosure); // AC-04
describe("revocation outage", revocationOutage); // AC-05
describe("restart sweep", restartSweep); // AC-06
describe("real denial proof", realDenialProof); // AC-07 (live sandbox: real PostgreSQL provider)
describe("offline demo", offlineDemo); // AC-08
describe("redaction and hostile input", redactionAndHostileInput); // AC-09
describe("portability and corruption", portabilityAndCorruption); // AC-10
describe("workspace isolation", workspaceIsolation); // AC-12
describe("restart and restore", restartAndRestore); // AC-13
