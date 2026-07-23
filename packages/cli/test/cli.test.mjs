import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parse, stringify } from "yaml";

import {
  finalizeListing,
  openBuzzDesktop,
  openSubmissionPage,
  resolveApprovedAgent,
  run,
} from "../src/beekeep.mjs";

const snapshotBytes = Buffer.from(
  JSON.stringify({
    snapshot_version: 1,
    definition: {
      display_name: "Test Agent",
      system_prompt: "Help with a focused task.",
      env_vars: {},
    },
    memory: {
      level: "none",
      entries: [],
    },
  }),
);

const validDraft = {
  schema_version: 1,
  slug: "alice/test-agent",
  name: "Test Agent",
  summary: "Helps with one focused and repeatable task.",
  description:
    "A test agent used to verify the Beekeep submission and install workflow.",
  category: "other",
  author: {
    name: "Alice Example",
  },
  version: "1.0.0",
  license: "MIT",
  source: {
    repository: "https://github.com/example/placeholder",
    commit: "0".repeat(40),
    path: "placeholder.agent.json",
  },
  snapshot: {
    sha256: "0".repeat(64),
    size_bytes: 2,
  },
  status: "approved",
};

function response(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("finalizeListing replaces immutable source and snapshot fields", () => {
  const listing = finalizeListing(
    validDraft,
    {
      repository: "https://github.com/alice/agents",
      commit: "a".repeat(40),
      path: "test-agent.agent.json",
    },
    snapshotBytes,
  );

  assert.equal(listing.source.repository, "https://github.com/alice/agents");
  assert.equal(listing.source.commit, "a".repeat(40));
  assert.equal(
    listing.snapshot.sha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  assert.equal(listing.snapshot.size_bytes, snapshotBytes.length);
});

test("resolveApprovedAgent validates listing, digest, bytes, and policy", async () => {
  const sha256 = createHash("sha256").update(snapshotBytes).digest("hex");
  const listing = {
    ...structuredClone(validDraft),
    source: {
      repository: "https://github.com/alice/agents",
      commit: "a".repeat(40),
      path: "test-agent.agent.json",
    },
    snapshot: {
      sha256,
      size_bytes: snapshotBytes.length,
    },
  };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("agents/alice/test-agent.yaml")) {
      return response(stringify(listing));
    }
    return response(snapshotBytes);
  };

  const resolved = await resolveApprovedAgent("alice/test-agent", {
    baseUrl: "https://registry.example/main",
    fetchImpl,
  });
  assert.equal(resolved.listing.slug, "alice/test-agent");
  assert.equal(resolved.report.sha256, sha256);
  assert.deepEqual(resolved.bytes, snapshotBytes);
});

test("resolveApprovedAgent rejects suspended listings", async () => {
  const listing = {
    ...structuredClone(validDraft),
    status: "suspended",
  };
  await assert.rejects(
    resolveApprovedAgent("alice/test-agent", {
      baseUrl: "https://registry.example/main",
      fetchImpl: async () => response(stringify(listing)),
    }),
    /is suspended and cannot be installed/,
  );
});

test("openBuzzDesktop launches the installed macOS app without a shell", () => {
  let invocation;
  const result = openBuzzDesktop({
    platform: "darwin",
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return {
        status: 0,
        stdout: "",
        stderr: "",
      };
    },
  });

  assert.equal(invocation.command, "open");
  assert.deepEqual(invocation.args, ["-a", "Buzz"]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.equal(result.opened, true);
});

test("add verifies and caches the snapshot before opening Buzz", async (t) => {
  const sha256 = createHash("sha256").update(snapshotBytes).digest("hex");
  const listing = {
    ...structuredClone(validDraft),
    source: {
      repository: "https://github.com/alice/agents",
      commit: "a".repeat(40),
      path: "test-agent.agent.json",
    },
    snapshot: {
      sha256,
      size_bytes: snapshotBytes.length,
    },
  };
  let invocation;
  const result = await run(["add", "alice/test-agent"], {
    baseUrl: "https://registry.example/main",
    fetchImpl: async (url) =>
      String(url).endsWith("agents/alice/test-agent.yaml")
        ? response(stringify(listing))
        : response(snapshotBytes),
    platform: "darwin",
    spawnImpl(command, args) {
      invocation = { command, args };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  t.after(() => rm(result.cachedFile, { force: true }));

  assert.equal(invocation.command, "open");
  assert.deepEqual(invocation.args, ["-a", "Buzz"]);
  assert.equal(result.buzz.opened, true);
  assert.equal(result.manualImportRequired, true);
  assert.match(result.message, /Import agent snapshot/);
  assert.deepEqual(await readFile(result.cachedFile), snapshotBytes);
});

test("openSubmissionPage passes the review URL without shell interpolation", () => {
  let invocation;
  const url =
    "https://github.com/example/repo/issues/new?agent-name=A%26B&license=MIT";
  const result = openSubmissionPage(url, {
    platform: "darwin",
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return {
        status: 0,
        stdout: "",
        stderr: "",
      };
    },
  });

  assert.equal(invocation.command, "open");
  assert.deepEqual(invocation.args, [url]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.equal(result.opened, true);
});

test("submit derives immutable fields from a pushed creator snapshot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "beekeep-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const creator = path.join(root, "creator");
  const registry = path.join(root, "registry");
  await mkdir(creator);
  await mkdir(registry);
  git(creator, ["init", "--quiet"]);
  git(creator, ["config", "user.name", "Alice Example"]);
  git(creator, ["config", "user.email", "alice@example.com"]);
  git(creator, [
    "remote",
    "add",
    "origin",
    "https://github.com/alice/agents.git",
  ]);

  const snapshotPath = path.join(creator, "test-agent.agent.json");
  const draftPath = path.join(root, "draft.yaml");
  await writeFile(snapshotPath, snapshotBytes);
  await writeFile(draftPath, stringify(validDraft));
  git(creator, ["add", "test-agent.agent.json"]);
  git(creator, ["commit", "--quiet", "-m", "add test agent"]);
  const commit = git(creator, ["rev-parse", "HEAD"]);

  const result = await run(
    [
      "submit",
      snapshotPath,
      "--listing",
      draftPath,
      "--registry",
      registry,
    ],
    {
      fetchImpl: async () => response(snapshotBytes),
    },
  );

  assert.equal(result.readyForPullRequest, true);
  const listing = parse(await readFile(result.listing, "utf8"));
  assert.equal(listing.source.repository, "https://github.com/alice/agents");
  assert.equal(listing.source.commit, commit);
  assert.equal(listing.source.path, "test-agent.agent.json");
  assert.equal(listing.snapshot.size_bytes, snapshotBytes.length);
  assert.equal(
    listing.snapshot.sha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  await assert.rejects(
    run(
      [
        "submit",
        snapshotPath,
        "--listing",
        draftPath,
        "--registry",
        registry,
      ],
      { fetchImpl: async () => response(snapshotBytes) },
    ),
    /output already exists/,
  );
});

test("interactive submit validates the pushed snapshot and pre-fills review", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "beekeep-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const creator = path.join(root, "creator");
  await mkdir(creator);
  git(creator, ["init", "--quiet"]);
  git(creator, ["config", "user.name", "Alice Example"]);
  git(creator, ["config", "user.email", "alice@example.com"]);
  git(creator, [
    "remote",
    "add",
    "origin",
    "https://github.com/alice/agents.git",
  ]);

  const snapshotPath = path.join(creator, "test-agent.agent.json");
  await writeFile(snapshotPath, snapshotBytes);
  git(creator, ["add", "test-agent.agent.json"]);
  git(creator, ["commit", "--quiet", "-m", "add test agent"]);
  const commit = git(creator, ["rev-parse", "HEAD"]);

  const answers = [
    "Research Brief",
    "Produces a focused research brief with direct source links.",
    "research",
    "",
    "MIT",
  ];
  const questions = [];
  let fetchedUrl;
  let openedUrl;
  const result = await run(["submit", snapshotPath], {
    fetchImpl: async (url) => {
      fetchedUrl = String(url);
      return response(snapshotBytes);
    },
    promptImpl: async (question) => {
      questions.push(question);
      return answers.shift();
    },
    openUrlImpl: (url) => {
      openedUrl = url;
      return { opened: true };
    },
  });

  assert.equal(questions.length, 5);
  assert.equal(
    fetchedUrl,
    `https://raw.githubusercontent.com/alice/agents/${commit}/test-agent.agent.json`,
  );
  assert.equal(result.readyForReview, true);
  assert.equal(result.browserOpened, true);
  assert.equal(openedUrl, result.submissionUrl);
  assert.equal(
    result.snapshot.sha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );

  const submission = new URL(result.submissionUrl);
  assert.equal(submission.origin, "https://github.com");
  assert.equal(
    submission.pathname,
    "/bartlomein/beekeep-registry/issues/new",
  );
  assert.equal(
    submission.searchParams.get("template"),
    "agent-submission.yml",
  );
  assert.equal(submission.searchParams.get("request-type"), "New agent");
  assert.equal(
    submission.searchParams.get("snapshot-url"),
    `https://github.com/alice/agents/blob/${commit}/test-agent.agent.json`,
  );
  assert.equal(submission.searchParams.get("agent-name"), "Research Brief");
  assert.equal(
    submission.searchParams.get("description"),
    "Produces a focused research brief with direct source links.",
  );
  assert.equal(submission.searchParams.get("category"), "Research");
  assert.equal(submission.searchParams.get("version"), "1.0.0");
  assert.equal(submission.searchParams.get("license"), "MIT");
});

test("run returns bounded help and rejects an invalid slug", async () => {
  const help = await run(["--help"]);
  assert.match(help.help, /beekeep add/);
  await assert.rejects(run(["add", "../bad"]), /invalid agent slug/);
});
