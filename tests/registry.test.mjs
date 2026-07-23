import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertListingObject,
  assertListingPath,
  expectedListingPath,
  inspectSnapshot,
  parseListingYaml,
  rawSnapshotUrl,
  validateRemoteSnapshot,
} from "../scripts/lib/registry.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const exampleYaml = await readFile(
  path.join(repositoryRoot, "examples", "research-brief.yaml"),
  "utf8",
);
const validListing = parseListingYaml(exampleYaml, "example listing");

test("example listing matches the strict v1 schema", () => {
  assert.equal(validListing.schema_version, 1);
  assert.equal(validListing.slug, "alice/research-brief");
  assert.equal(
    expectedListingPath(validListing.slug),
    path.join("agents", "alice", "research-brief.yaml"),
  );
});

test("listing schema rejects unknown fields", () => {
  assert.throws(
    () =>
      assertListingObject({
        ...structuredClone(validListing),
        unsupported: true,
      }),
    /must NOT have additional properties/,
  );
});

test("listing parser rejects duplicate YAML keys", () => {
  assert.throws(
    () => parseListingYaml("schema_version: 1\nschema_version: 1\n"),
    /Map keys must be unique/,
  );
});

test("listing parser rejects YAML aliases", () => {
  const listingWithAlias = exampleYaml
    .replace("name: Research Brief", "name: &shared Research Brief")
    .replace("name: Alice Example", "name: *shared");

  assert.throws(
    () => parseListingYaml(listingWithAlias),
    /Alias resolution is disabled/,
  );
});

test("raw snapshot URL is pinned to the declared commit and path", () => {
  assert.equal(
    rawSnapshotUrl(validListing),
    "https://raw.githubusercontent.com/alice/buzz-agents/4b825dc642cb6eb9a060e54bf8d69288fbee4904/research-brief/research-brief.agent.json",
  );
});

test("listing path must match its slug", () => {
  assert.throws(
    () =>
      assertListingPath(
        path.join(repositoryRoot, "agents", "alice", "wrong-name.yaml"),
        validListing,
        repositoryRoot,
      ),
    /listing path must be agents\/alice\/research-brief\.yaml/,
  );
});

test("config-only snapshot passes policy inspection", () => {
  const report = inspectSnapshot({
    snapshot_version: 1,
    definition: {
      display_name: "Research Brief",
      system_prompt: "Create a concise, sourced brief.",
      respond_to: "owner-only",
      respond_to_allowlist: [],
      parallelism: 1,
      env_vars: {},
    },
    memory: {
      level: "none",
      source_pubkey: "a".repeat(64),
      entries: [],
    },
    tools: ["web-search"],
    skills: [{ name: "research" }],
  });

  assert.equal(report.memory, "none");
  assert.equal(report.display_name, "Research Brief");
  assert.equal(report.prompt.characters, 32);
  assert.deepEqual(report.tools, ["web-search"]);
  assert.deepEqual(report.skills, ["research"]);
});

test("snapshot policy rejects included memory", () => {
  assert.throws(
    () =>
      inspectSnapshot({
        memory: {
          level: "core",
          entries: [{ content: "private context" }],
        },
      }),
    /includes agent memory/,
  );
});

test("snapshot policy rejects executable commands and environment values", () => {
  assert.throws(
    () =>
      inspectSnapshot({
        definition: {
          agent_command: "run-anything",
          env_vars: {
            SAFE_LOOKING_NAME: "still-not-distributable",
          },
        },
      }),
    /executable configuration|environment values/,
  );
});

test("snapshot policy rejects high-confidence credential values", () => {
  assert.throws(
    () =>
      inspectSnapshot({
        notes: `credential: ghp_${"a".repeat(36)}`,
      }),
    /credential-like value/,
  );
});

test("remote validation verifies size, digest, JSON, and policy", async () => {
  const bytes = Buffer.from(
    JSON.stringify({
      definition: {
        display_name: "Research Brief",
        system_prompt: "Create a concise, sourced brief.",
        env_vars: {},
      },
      memory: {
        level: "none",
        entries: [],
      },
    }),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const listing = {
    ...structuredClone(validListing),
    snapshot: {
      sha256,
      size_bytes: bytes.length,
    },
  };
  const fetchImpl = async () =>
    new Response(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.length),
        "content-type": "application/json",
      },
    });

  const report = await validateRemoteSnapshot(listing, { fetchImpl });
  assert.equal(report.sha256, sha256);
  assert.equal(report.size_bytes, bytes.length);
  assert.equal(report.memory, "none");
});

test("remote validation rejects a digest mismatch", async () => {
  const bytes = Buffer.from("{}");
  const listing = {
    ...structuredClone(validListing),
    snapshot: {
      sha256: "0".repeat(64),
      size_bytes: bytes.length,
    },
  };

  await assert.rejects(
    validateRemoteSnapshot(listing, {
      fetchImpl: async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-length": String(bytes.length),
          },
        }),
    }),
    /SHA-256 mismatch/,
  );
});

test("remote validation rejects a declared size mismatch", async () => {
  const bytes = Buffer.from("{}");
  const listing = {
    ...structuredClone(validListing),
    snapshot: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length + 1,
    },
  };

  await assert.rejects(
    validateRemoteSnapshot(listing, {
      fetchImpl: async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-length": String(bytes.length),
          },
        }),
    }),
    /snapshot size mismatch/,
  );
});
