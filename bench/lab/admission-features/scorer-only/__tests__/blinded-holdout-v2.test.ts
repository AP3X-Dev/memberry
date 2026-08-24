import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  BLINDED_HOLDOUT_CANDIDATE_SHA256,
  BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA,
  BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID,
  BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
  BLINDED_HOLDOUT_INPUT_SHA256,
  BLINDED_HOLDOUT_ORACLE_SHA256,
  BLINDED_HOLDOUT_BASE_IMAGE,
  BLINDED_HOLDOUT_PLATFORM,
  BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256,
  BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256,
  BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID,
  BLINDED_HOLDOUT_RETIRED_V1_ONE_SHOT_KEY,
  blindedHoldoutOneShotKeyV2,
  parseBlindedHoldoutReceiptV2,
} from "../blinded-holdout-artifact.js";
import {
  parseBlindedHoldoutStartReceiptV2,
  validateBlindedHoldoutBurnAuthorityAbsenceV2,
} from "../blinded-holdout.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const SCORER_ENTRY = join(
  REPO_ROOT,
  "bench/lab/admission-features/scorer-only/blinded-holdout.ts",
);
const POLICY_V2_PATH = join(
  REPO_ROOT,
  "bench/lab/admission-features/contracts/c2-runtime-policy-receipt.v2.json",
);
const POLICY_V1_PATH = join(
  REPO_ROOT,
  "bench/lab/admission-features/contracts/c2-runtime-policy-receipt.v1.json",
);
const TSX_CLI = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

function runPreflight(
  receiptPath: string,
  outputPath: string,
  extraPaths: readonly string[] = [],
) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  return spawnSync(
    process.execPath,
    [
      TSX_CLI,
      SCORER_ENTRY,
      "preflight",
      receiptPath,
      outputPath,
      ...extraPaths,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "AP3X-Dev/memberry",
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: head,
        MEMBERRY_PRIOR_AUTHORITATIVE_RECEIPTS: "0",
        MEMBERRY_CANDIDATE_CONTEXT_ONLY: "true",
        MEMBERRY_OBSERVED_PLATFORM: BLINDED_HOLDOUT_PLATFORM,
        MEMBERRY_OBSERVED_BASE_IMAGE: BLINDED_HOLDOUT_BASE_IMAGE,
        MEMBERRY_OBSERVED_CANDIDATE_COMMIT_SHA:
          BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA,
        MEMBERRY_OBSERVED_REPOSITORY_ROOT_TREE_OID:
          BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID,
        MEMBERRY_OBSERVED_HISTORICAL_CANDIDATE_SUBTREE_OID:
          BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
        MEMBERRY_OBSERVED_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID:
          BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID,
        MEMBERRY_OBSERVED_INPUT_SHA256: BLINDED_HOLDOUT_INPUT_SHA256,
      },
    },
  );
}

describe("MEM-002C3 Decision 51 v2 identity repair", () => {
  it("loads the assembled v2 policy through the real preflight CLI", async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), "memberry-mem002c3-assembly-"),
    );
    const outputPath = join(temporary, "preflight.json");
    try {
      const result = runPreflight(POLICY_V2_PATH, outputPath);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        schemaVersion:
          "memberry.admission-feature-blinded-holdout-preflight.v2",
        policyReceiptSha256: BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256,
        policyReceiptCanonicalBytesSha256:
          BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256,
      });

      const missing = runPreflight(
        join(temporary, "missing-v2.json"),
        join(temporary, "missing-preflight.json"),
      );
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toBe("mem002c3_protocol:policy_authority\n");

      const modifiedV2Path = join(temporary, "modified-v2.json");
      await writeFile(
        modifiedV2Path,
        `${await readFile(POLICY_V2_PATH, "utf8")} `,
        "utf8",
      );
      const modified = runPreflight(
        modifiedV2Path,
        join(temporary, "modified-preflight.json"),
      );
      expect(modified.status).not.toBe(0);
      expect(modified.stderr).toBe("mem002c3_protocol:policy_authority\n");

      const callerSelectedLegacy = runPreflight(
        POLICY_V2_PATH,
        join(temporary, "arbitrary-legacy-preflight.json"),
        [POLICY_V1_PATH],
      );
      expect(callerSelectedLegacy.status).not.toBe(0);
      expect(callerSelectedLegacy.stderr).toBe("mem002c3_protocol:command\n");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("splits the repository root and candidate subtree identities without an ambiguous tree field", () => {
    expect(BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID).toBe(
      "94c75dd3a36a708ce6add1f10eaf606fa4ffea8d",
    );
    expect(BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID).toBe(
      "03d7c50515f6ab767fd41b7d41bd231531a4ab58",
    );
    expect(BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID).toBe(
      "1f1318ce97934145d496cc55642fdd37a3f4437d",
    );
    expect(BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID).not.toBe(
      BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
    );

    const keySource = blindedHoldoutOneShotKeyV2.toString();
    expect(keySource).not.toContain(`candidate${"Tree"}Oid`);
    expect(keySource).not.toContain("repositoryRootTreeOid");
    expect(keySource).not.toContain("candidateCommitSha");
    expect(keySource).not.toContain("policyReceiptSha256");
    expect(keySource).not.toContain("policyReceiptCanonicalBytesSha256");
  });

  it("binds the stable pair only and cannot be reopened by infrastructure identity changes", () => {
    const stablePair = {
      schemaVersion:
        "memberry.admission-feature-blinded-holdout-key.v2" as const,
      candidateSubtreeOid: BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
      candidateSha256: BLINDED_HOLDOUT_CANDIDATE_SHA256,
      inputSha256: BLINDED_HOLDOUT_INPUT_SHA256,
      oracleSha256: BLINDED_HOLDOUT_ORACLE_SHA256,
    };
    const key = blindedHoldoutOneShotKeyV2(stablePair);

    expect(blindedHoldoutOneShotKeyV2({ ...stablePair })).toBe(key);
    const infrastructure = {
      repositoryRootTreeOid: "0".repeat(40),
      currentCheckoutCandidateSubtreeOid: "5".repeat(40),
      candidateCommitSha: "1".repeat(40),
      policyReceiptSha256: `sha256:${"4".repeat(64)}`,
      policyReceiptCanonicalBytesSha256: `sha256:${"8".repeat(64)}`,
      infrastructureCommitSha: "2".repeat(40),
    };
    infrastructure.repositoryRootTreeOid = "6".repeat(40);
    infrastructure.currentCheckoutCandidateSubtreeOid = "7".repeat(40);
    expect(blindedHoldoutOneShotKeyV2({ ...stablePair })).toBe(key);
    expect(() =>
      blindedHoldoutOneShotKeyV2({ ...stablePair, ...infrastructure } as never),
    ).toThrow("mem002c3_artifact:identity");
    for (const mutation of [
      {
        ...stablePair,
        schemaVersion: "memberry.admission-feature-blinded-holdout-key.v3",
      },
      { ...stablePair, candidateSubtreeOid: "0".repeat(40) },
      { ...stablePair, candidateSha256: `sha256:${"1".repeat(64)}` },
      { ...stablePair, inputSha256: `sha256:${"2".repeat(64)}` },
      { ...stablePair, oracleSha256: `sha256:${"3".repeat(64)}` },
    ]) {
      expect(blindedHoldoutOneShotKeyV2(mutation as never)).not.toBe(key);
    }

    expect(BLINDED_HOLDOUT_RETIRED_V1_ONE_SHOT_KEY).not.toBe(key);
  });

  it("derives the exact stable key without invoking hostile object hooks", () => {
    const expected =
      "sha256:e500407fcd48106f66131f75a3e6ee2f127758ae0c6f8b37835c968672c9bc98";
    const stable = {
      schemaVersion: "memberry.admission-feature-blinded-holdout-key.v2",
      candidateSubtreeOid: BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
      candidateSha256: BLINDED_HOLDOUT_CANDIDATE_SHA256,
      inputSha256: BLINDED_HOLDOUT_INPUT_SHA256,
      oracleSha256: BLINDED_HOLDOUT_ORACLE_SHA256,
    };
    expect(blindedHoldoutOneShotKeyV2()).toBe(expected);

    let hooks = 0;
    const proxy = new Proxy(stable, {
      get: () => {
        hooks += 1;
        return "poison";
      },
      getOwnPropertyDescriptor: () => {
        hooks += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        hooks += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        hooks += 1;
        return [];
      },
    });
    expect(() => blindedHoldoutOneShotKeyV2(proxy as never)).toThrow(
      "mem002c3_artifact:identity",
    );
    expect(hooks).toBe(0);

    const getterIdentity = {};
    Object.defineProperties(
      getterIdentity,
      Object.fromEntries(
        Object.entries(stable).map(([key, value]) => [
          key,
          {
            enumerable: true,
            configurable: true,
            get: () => {
              hooks += 1;
              return value;
            },
          },
        ]),
      ),
    );
    expect(() => blindedHoldoutOneShotKeyV2(getterIdentity as never)).toThrow(
      "mem002c3_artifact:identity",
    );
    expect(hooks).toBe(0);

    const revoked = Proxy.revocable(stable, {});
    revoked.revoke();
    expect(() => blindedHoldoutOneShotKeyV2(revoked.proxy as never)).toThrow(
      "mem002c3_artifact:identity",
    );
    expect(() =>
      blindedHoldoutOneShotKeyV2({ ...stable, extra: true } as never),
    ).toThrow("mem002c3_artifact:identity");
  });

  it("is invariant to ambient JSON and Object prototype drift with zero hooks", () => {
    const expected =
      "sha256:e500407fcd48106f66131f75a3e6ee2f127758ae0c6f8b37835c968672c9bc98";
    const originalJson = globalThis.JSON;
    const originalOwnKeys = Reflect.ownKeys;
    const originalGetPrototypeOf = Object.getPrototypeOf;
    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    let hooks = 0;
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => {
        hooks += 1;
        return { poisoned: true };
      },
    });
    try {
      globalThis.JSON = {
        ...originalJson,
        stringify: () => {
          hooks += 1;
          return "poison";
        },
      } as JSON;
      Reflect.ownKeys = (() => {
        hooks += 1;
        return [];
      }) as typeof Reflect.ownKeys;
      Object.getPrototypeOf = (() => {
        hooks += 1;
        return null;
      }) as typeof Object.getPrototypeOf;
      Object.getOwnPropertyDescriptor = (() => {
        hooks += 1;
        return undefined;
      }) as typeof Object.getOwnPropertyDescriptor;
      expect(blindedHoldoutOneShotKeyV2()).toBe(expected);
      expect(hooks).toBe(0);
    } finally {
      globalThis.JSON = originalJson;
      Reflect.ownKeys = originalOwnKeys;
      Object.getPrototypeOf = originalGetPrototypeOf;
      Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
  });

  it("checks both retired-v1 and v2 durable and evidence authorities before any start", () => {
    const clean = {
      retiredV1LookupStatus: 404,
      v2LookupStatus: 404,
      retiredV1EvidenceArtifactCount: 0,
      v2EvidenceArtifactCount: 0,
      knownFailedV1RunArtifactCount: 0,
    };
    expect(validateBlindedHoldoutBurnAuthorityAbsenceV2(clean)).toBe(true);

    for (const mutation of [
      { retiredV1LookupStatus: 200 },
      { v2LookupStatus: 200 },
      { retiredV1EvidenceArtifactCount: 1 },
      { v2EvidenceArtifactCount: 1 },
      { knownFailedV1RunArtifactCount: 1 },
    ]) {
      expect(() =>
        validateBlindedHoldoutBurnAuthorityAbsenceV2({ ...clean, ...mutation }),
      ).toThrow(/^mem002c3_protocol:/);
    }
  });

  it("rejects legacy result bytes as authoritative v2 evidence", () => {
    const legacy = new TextEncoder().encode(
      `${JSON.stringify({
        schemaVersion: "memberry.admission-feature-blinded-holdout-receipt.v1",
      })}\n`,
    );
    expect(() => parseBlindedHoldoutReceiptV2(legacy)).toThrow(
      /^mem002c3_artifact:/,
    );
    expect(() => parseBlindedHoldoutStartReceiptV2(legacy)).toThrow(
      /^mem002c3_protocol:/,
    );
  });

  it("binds the isolated neutral v2 seam to the frozen export, path, and receipt hash", async () => {
    const protocol = await readFile(
      `${REPO_ROOT}/bench/lab/admission-features/scorer-only/blinded-holdout.ts`,
      "utf8",
    );
    const workflow = await readFile(
      `${REPO_ROOT}/.github/workflows/mem002c3-holdout.yml`,
      "utf8",
    );

    expect(protocol).toContain(
      "'../contracts/c2-runtime-policy-receipt-v2.js'",
    );
    expect(protocol).toContain("'parseAdmissionC2RuntimePolicyReceiptV2'");
    expect(
      protocol.match(/await loadPolicyReceipt\(receiptPath\)/g),
    ).toHaveLength(3);
    expect(workflow).toContain(
      "POLICY_RECEIPT: bench/lab/admission-features/contracts/c2-runtime-policy-receipt.v2.json",
    );
    expect(workflow).toMatch(/finalize \\\s+"\$POLICY_RECEIPT"/);
    expect(BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256).toBe(
      "sha256:ff9d0df0e9e5e47da0e34e56294b713ba8a8ce9b216b6bec590b8826f5818f01",
    );
    expect(BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256).toBe(
      "sha256:ebad2b9da6dd555c033ff2e7936f0eeeaa0a6552f61d5016125b0b526e133bcb",
    );
  });

  it("proves root, historical subtree, and checkout subtree before archiving only that subtree", async () => {
    const workflow = await readFile(
      `${REPO_ROOT}/.github/workflows/mem002c3-holdout.yml`,
      "utf8",
    );
    const rootCheck = workflow.indexOf(
      'observed_repository_root_tree_oid="$(git rev-parse "${CANDIDATE_COMMIT_SHA}^{tree}")"',
    );
    const historicalCheck = workflow.indexOf(
      'observed_historical_candidate_subtree_oid="$(git rev-parse',
    );
    const checkoutCheck = workflow.indexOf(
      'observed_checkout_candidate_subtree_oid="$(git rev-parse',
    );
    const archive = workflow.indexOf("git archive --format=tar");

    expect(rootCheck).toBeGreaterThan(0);
    expect(historicalCheck).toBeGreaterThan(rootCheck);
    expect(checkoutCheck).toBeGreaterThan(historicalCheck);
    expect(archive).toBeGreaterThan(checkoutCheck);
    expect(workflow).toContain(
      '"${CANDIDATE_COMMIT_SHA}:bench/lab/admission-features/candidate"',
    );
    expect(workflow).not.toMatch(/git archive[\s\S]{0,160}\bHEAD:/);
    expect(workflow).toContain("HISTORICAL_CANDIDATE_SUBTREE_OID");
    expect(workflow).toContain("CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID");
    expect(workflow).not.toContain("CANDIDATE_TREE_OID");
    expect(workflow).not.toContain(`candidate${"Tree"}Oid`);
  });
});
