import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { parseDocument, stringify } from "yaml";

import {
  assertListingObject,
  downloadRemoteSnapshot,
  expectedListingPath,
  inspectSnapshot,
  parseListingYaml,
  validateRemoteSnapshot,
} from "../../../scripts/lib/registry.mjs";

export const DEFAULT_REGISTRY_BASE_URL =
  "https://raw.githubusercontent.com/bartlomein/beekeep-registry/main";
export const DEFAULT_SUBMISSION_URL =
  "https://github.com/bartlomein/beekeep-registry/issues/new";

const CATEGORIES = [
  "research",
  "marketing",
  "engineering",
  "operations",
  "other",
];
const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+() -]*$/;

const HELP = `beekeep — submit and install reviewed Buzz agents

Usage:
  beekeep add <publisher/agent> [--download-only]
  beekeep submit <snapshot.agent.json>
  beekeep submit <snapshot.agent.json> --listing <draft.yaml> [--registry <dir>]

Commands:
  add       Download and verify an approved listing, then open Buzz for import
  submit    Validate a committed snapshot and open a pre-filled review request

Add options:
  --download-only              Verify and cache the snapshot without opening Buzz
  --registry-base-url <url>    Registry raw-content base URL

Submit options:
  --no-open                    Print the review URL without opening a browser
  --listing <path>             Advanced mode: finalize a listing draft
  --registry <dir>             Write agents/<publisher>/<agent>.yaml in this checkout
  --output <path>              Write to an explicit path instead
  --force                      Replace an existing output listing

Environment:
  BEEKEEP_REGISTRY_BASE_URL    Default registry raw-content base URL
`;

function fail(message) {
  const error = new Error(message);
  error.userError = true;
  throw error;
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`invalid registry base URL: ${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    fail("registry base URL must use http or https");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function parseFlags(args, allowedBooleanFlags = new Set()) {
  const positionals = [];
  const flags = new Map();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (allowedBooleanFlags.has(arg)) {
      flags.set(arg, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${arg} requires a value`);
    }
    if (flags.has(arg)) {
      fail(`${arg} may only be provided once`);
    }
    flags.set(arg, value);
    index += 1;
  }

  return { positionals, flags };
}

function assertSlug(slug) {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(
      slug,
    )
  ) {
    fail(
      `invalid agent slug "${slug}"; expected lowercase publisher/agent-name`,
    );
  }
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/yaml,text/yaml,text/plain",
      "user-agent": "beekeep-cli/0.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    fail(`registry listing fetch failed with HTTP ${response.status} for ${url}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024) {
    fail("registry listing exceeds the 64 KiB limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    fail("registry listing exceeds the 64 KiB limit");
  }
  return text;
}

export async function resolveApprovedAgent(
  slug,
  {
    baseUrl = process.env.BEEKEEP_REGISTRY_BASE_URL ??
      DEFAULT_REGISTRY_BASE_URL,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  assertSlug(slug);
  const listingPath = expectedListingPath(slug).split(path.sep).join("/");
  const listingUrl = `${normalizeBaseUrl(baseUrl)}/${listingPath}`;
  const listing = parseListingYaml(
    await fetchText(listingUrl, fetchImpl),
    listingUrl,
  );
  if (listing.slug !== slug) {
    fail(
      `registry path requested ${slug}, but the listing declares ${listing.slug}`,
    );
  }
  if (listing.status !== "approved") {
    fail(`agent ${slug} is ${listing.status} and cannot be installed`);
  }
  const downloaded = await downloadRemoteSnapshot(listing, { fetchImpl });
  return {
    listing,
    listingUrl,
    ...downloaded,
  };
}

export async function cacheVerifiedSnapshot(slug, sha256, bytes) {
  const directory = path.join(os.tmpdir(), "beekeep");
  const fileName = `${slug.replace("/", "--")}-${sha256.slice(0, 12)}.agent.json`;
  const filePath = path.join(directory, fileName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(filePath, bytes, { mode: 0o600 });
  return filePath;
}

export function openBuzzDesktop(
  { platform = process.platform, spawnImpl = spawnSync } = {},
) {
  const invocation =
    platform === "darwin"
      ? ["open", ["-a", "Buzz"]]
      : platform === "win32"
        ? ["cmd.exe", ["/d", "/s", "/c", "start", "", "Buzz"]]
        : ["gtk-launch", ["xyz.block.buzz.app"]];
  const result = spawnImpl(invocation[0], invocation[1], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      opened: false,
      error:
        result.error?.message ||
        (result.stderr || result.stdout || "Buzz launch command failed").trim(),
    };
  }
  return { opened: true };
}

async function commandAdd(args, dependencies = {}) {
  const { positionals, flags } = parseFlags(
    args,
    new Set(["--download-only"]),
  );
  if (positionals.length !== 1) {
    fail("add requires exactly one publisher/agent slug");
  }
  for (const flag of flags.keys()) {
    if (!["--download-only", "--registry-base-url"].includes(flag)) {
      fail(`unknown add option: ${flag}`);
    }
  }

  const slug = positionals[0];
  const resolved = await resolveApprovedAgent(slug, {
    baseUrl:
      flags.get("--registry-base-url") ??
      dependencies.baseUrl ??
      process.env.BEEKEEP_REGISTRY_BASE_URL ??
      DEFAULT_REGISTRY_BASE_URL,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
  });
  const filePath = await cacheVerifiedSnapshot(
    slug,
    resolved.report.sha256,
    resolved.bytes,
  );
  const downloadOnly = flags.has("--download-only");
  const buzz = downloadOnly
    ? null
    : openBuzzDesktop({
        platform: dependencies.platform ?? process.platform,
        spawnImpl: dependencies.spawnImpl ?? spawnSync,
      });

  return {
    ok: true,
    action: "add",
    slug,
    version: resolved.listing.version,
    sha256: resolved.report.sha256,
    sizeBytes: resolved.report.size_bytes,
    cachedFile: filePath,
    buzz,
    importConfirmed: false,
    manualImportRequired: !downloadOnly,
    message: downloadOnly
      ? "Verified snapshot downloaded. Buzz was not opened."
      : buzz.opened
        ? `Verified snapshot downloaded to ${filePath}. Buzz was opened. Choose New agent, then Import agent snapshot, and select this file.`
        : `Verified snapshot downloaded to ${filePath}. Open Buzz, choose New agent, then Import agent snapshot, and select this file.`,
  };
}

function runGit(directory, args, { binary = false } = {}) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: binary ? null : "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) {
    fail(`could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    fail(`git ${args[0]} failed: ${(stderr || "").trim()}`);
  }
  return binary ? result.stdout : result.stdout.trim();
}

function githubRepositoryUrl(remote) {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(trimmed);
  if (ssh) {
    return `https://github.com/${ssh[1]}/${ssh[2]}`;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail("git origin must point to a public github.com owner/repo repository");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    !["https:", "ssh:"].includes(parsed.protocol) ||
    parsed.hostname !== "github.com" ||
    segments.length !== 2
  ) {
    fail("git origin must point to a public github.com owner/repo repository");
  }
  return `https://github.com/${segments[0]}/${segments[1]}`;
}

async function inspectCommittedSource(snapshotPath) {
  const requestedPath = path.resolve(snapshotPath);
  const fileStat = await stat(requestedPath).catch(() => null);
  if (!fileStat?.isFile()) {
    fail(`snapshot file does not exist: ${requestedPath}`);
  }
  const absolutePath = await realpath(requestedPath);
  if (!absolutePath.toLowerCase().endsWith(".agent.json")) {
    fail("snapshot filename must end with .agent.json");
  }

  const directory = path.dirname(absolutePath);
  const repositoryRoot = runGit(directory, ["rev-parse", "--show-toplevel"]);
  const relativePath = path
    .relative(repositoryRoot, absolutePath)
    .split(path.sep)
    .join("/");
  if (relativePath.startsWith("../") || relativePath === "..") {
    fail("snapshot must be inside its creator repository");
  }
  const status = runGit(repositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    relativePath,
  ]);
  if (status) {
    fail("snapshot must be committed with no local changes before submission");
  }

  const localBytes = await readFile(absolutePath);
  const committedBytes = runGit(
    repositoryRoot,
    ["show", `HEAD:${relativePath}`],
    { binary: true },
  );
  if (!localBytes.equals(committedBytes)) {
    fail("snapshot bytes do not match the file at the repository HEAD");
  }

  return {
    bytes: localBytes,
    repository: githubRepositoryUrl(
      runGit(repositoryRoot, ["remote", "get-url", "origin"]),
    ),
    commit: runGit(repositoryRoot, ["rev-parse", "HEAD"]),
    path: relativePath,
  };
}

function inspectSnapshotBytes(bytes) {
  let snapshot;
  try {
    snapshot = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    fail(`snapshot is not valid UTF-8 JSON: ${error.message}`);
  }
  inspectSnapshot(snapshot);
}

async function promptValue(
  promptImpl,
  writeError,
  question,
  validate,
  defaultValue,
) {
  while (true) {
    const entered = String(await promptImpl(question)).trim();
    const value = entered || defaultValue || "";
    const validationError = validate(value);
    if (!validationError) {
      return value;
    }
    writeError(`${validationError}\n`);
  }
}

export async function collectSubmissionAnswers({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  promptImpl,
} = {}) {
  let prompt = promptImpl;
  let readline;
  if (!prompt) {
    if (!input.isTTY) {
      fail(
        "interactive submit requires a terminal; use --listing for advanced non-interactive mode",
      );
    }
    readline = createInterface({ input, output });
    prompt = (question) => readline.question(question);
  }

  const writeError = (message) => errorOutput.write(message);
  try {
    const name = await promptValue(
      prompt,
      writeError,
      "Agent name: ",
      (value) =>
        value.length >= 1 && value.length <= 80
          ? null
          : "Agent name must be between 1 and 80 characters.",
    );
    const description = await promptValue(
      prompt,
      writeError,
      "What does the agent do? (20-160 characters): ",
      (value) =>
        value.length >= 20 && value.length <= 160
          ? null
          : "Agent purpose must be between 20 and 160 characters.",
    );
    const category = (
      await promptValue(
        prompt,
        writeError,
        `Category (${CATEGORIES.join(", ")}): `,
        (value) =>
          CATEGORIES.includes(value.toLowerCase())
            ? null
            : `Category must be one of: ${CATEGORIES.join(", ")}.`,
      )
    ).toLowerCase();
    const version = await promptValue(
      prompt,
      writeError,
      "Version (1.0.0): ",
      (value) =>
        VERSION_PATTERN.test(value)
          ? null
          : "Version must use semantic versioning, for example 1.0.0.",
      "1.0.0",
    );
    const license = await promptValue(
      prompt,
      writeError,
      "License shown in the repository (for example MIT): ",
      (value) =>
        value.length <= 80 && LICENSE_PATTERN.test(value)
          ? null
          : "License must be an SPDX expression of 80 characters or fewer.",
    );

    return {
      name,
      description,
      category,
      version,
      license,
    };
  } finally {
    readline?.close();
  }
}

export function immutableSnapshotUrl(source) {
  const repositoryUrl = new URL(source.repository);
  const [owner, repository] = repositoryUrl.pathname.split("/").filter(Boolean);
  const encodedPath = source.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/blob/${source.commit}/${encodedPath}`;
}

export function buildSubmissionUrl(
  source,
  answers,
  { baseUrl = DEFAULT_SUBMISSION_URL } = {},
) {
  const url = new URL(baseUrl);
  const displayCategory =
    answers.category[0].toUpperCase() + answers.category.slice(1);
  url.searchParams.set("template", "agent-submission.yml");
  url.searchParams.set("title", `[Agent submission]: ${answers.name}`);
  url.searchParams.set("request-type", "New agent");
  url.searchParams.set("snapshot-url", immutableSnapshotUrl(source));
  url.searchParams.set("agent-name", answers.name);
  url.searchParams.set("description", answers.description);
  url.searchParams.set("category", displayCategory);
  url.searchParams.set("version", answers.version);
  url.searchParams.set("license", answers.license);
  return url.toString();
}

export function openSubmissionPage(
  url,
  {
    platform = process.platform,
    spawnImpl = spawnSync,
  } = {},
) {
  const invocation =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["explorer.exe", [url]]
        : ["xdg-open", [url]];
  const result = spawnImpl(invocation[0], invocation[1], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      opened: false,
      error:
        result.error?.message ||
        (result.stderr || result.stdout || "browser command failed").trim(),
    };
  }
  return { opened: true };
}

function parseDraftYaml(contents, sourceName) {
  const document = parseDocument(contents, {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(
      `${sourceName} is not valid YAML: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  try {
    const value = document.toJS({ maxAliasCount: 0 });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail("listing draft must contain a YAML object");
    }
    return value;
  } catch (error) {
    fail(`${sourceName} cannot use YAML aliases: ${error.message}`);
  }
}

export function finalizeListing(draft, source, bytes) {
  inspectSnapshotBytes(bytes);

  const listing = structuredClone(draft);
  listing.source = {
    repository: source.repository,
    commit: source.commit,
    path: source.path,
  };
  listing.snapshot = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.length,
  };
  listing.status ??= "approved";
  assertListingObject(listing);
  return listing;
}

async function commandSubmitListing(
  snapshotPath,
  listingPath,
  flags,
  dependencies,
) {
  if (flags.has("--registry") && flags.has("--output")) {
    fail("use either --registry or --output, not both");
  }

  const source = await inspectCommittedSource(snapshotPath);
  const draft = parseDraftYaml(
    await readFile(path.resolve(listingPath), "utf8"),
    listingPath,
  );
  const listing = finalizeListing(draft, source, source.bytes);
  await validateRemoteSnapshot(listing, {
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
  });

  const outputPath = flags.has("--registry")
    ? path.join(
        path.resolve(flags.get("--registry")),
        expectedListingPath(listing.slug),
      )
    : path.resolve(
        flags.get("--output") ?? `${listing.slug.replace("/", "--")}.yaml`,
      );
  if (!flags.has("--force")) {
    try {
      await access(outputPath);
      fail(`output already exists: ${outputPath}; use --force to replace it`);
    } catch (error) {
      if (error?.userError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    stringify(listing, {
      lineWidth: 80,
    }),
    { encoding: "utf8", mode: 0o644 },
  );

  return {
    ok: true,
    action: "submit",
    slug: listing.slug,
    listing: outputPath,
    source: listing.source,
    snapshot: listing.snapshot,
    readyForPullRequest: true,
    message:
      "Listing verified and written. Review it, then commit it to a beekeep-registry pull request.",
  };
}

async function commandInteractiveSubmit(snapshotPath, flags, dependencies) {
  for (const flag of ["--registry", "--output", "--force"]) {
    if (flags.has(flag)) {
      fail(`${flag} requires --listing <draft.yaml>`);
    }
  }

  const committedSource = await inspectCommittedSource(snapshotPath);
  inspectSnapshotBytes(committedSource.bytes);
  const source = {
    repository: committedSource.repository,
    commit: committedSource.commit,
    path: committedSource.path,
  };
  const snapshot = {
    sha256: createHash("sha256").update(committedSource.bytes).digest("hex"),
    size_bytes: committedSource.bytes.length,
  };
  try {
    await validateRemoteSnapshot(
      {
        source,
        snapshot,
      },
      {
        fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
      },
    );
  } catch (error) {
    fail(
      `pushed snapshot verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const answers = await collectSubmissionAnswers({
    input: dependencies.input,
    output: dependencies.output,
    errorOutput: dependencies.errorOutput,
    promptImpl: dependencies.promptImpl,
  });
  const submissionUrl = buildSubmissionUrl(source, answers, {
    baseUrl: dependencies.submissionUrl ?? DEFAULT_SUBMISSION_URL,
  });
  const browser = flags.has("--no-open")
    ? { opened: false, skipped: true }
    : await Promise.resolve(
        dependencies.openUrlImpl
          ? dependencies.openUrlImpl(submissionUrl)
          : openSubmissionPage(submissionUrl),
      );

  return {
    ok: true,
    action: "submit",
    mode: "interactive",
    source,
    snapshot,
    submissionUrl,
    browserOpened: browser?.opened === true,
    readyForReview: true,
    message:
      browser?.opened === true
        ? "Submission page opened. Confirm the safety checks, then click Submit new issue."
        : "Submission is ready. Open the URL, confirm the safety checks, then click Submit new issue.",
  };
}

async function commandSubmit(args, dependencies = {}) {
  const { positionals, flags } = parseFlags(
    args,
    new Set(["--force", "--no-open"]),
  );
  if (positionals.length !== 1) {
    fail("submit requires exactly one .agent.json snapshot path");
  }
  for (const flag of flags.keys()) {
    if (
      ![
        "--listing",
        "--registry",
        "--output",
        "--force",
        "--no-open",
      ].includes(flag)
    ) {
      fail(`unknown submit option: ${flag}`);
    }
  }

  const listingPath = flags.get("--listing");
  if (listingPath) {
    if (flags.has("--no-open")) {
      fail("--no-open cannot be used with --listing");
    }
    return commandSubmitListing(
      positionals[0],
      listingPath,
      flags,
      dependencies,
    );
  }
  return commandInteractiveSubmit(positionals[0], flags, dependencies);
}

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  const [command, ...args] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    return { help: HELP };
  }
  if (["--version", "-V"].includes(command)) {
    return { text: "0.1.0" };
  }
  if (command === "add") {
    return commandAdd(args, dependencies);
  }
  if (command === "submit") {
    return commandSubmit(args, dependencies);
  }
  fail(`unknown command: ${command}`);
}

async function main() {
  try {
    const result = await run();
    if (result.help) {
      process.stdout.write(result.help);
    } else if (result.text) {
      process.stdout.write(`${result.text}\n`);
    } else if (result.submissionUrl) {
      process.stdout.write(`${result.message}\n${result.submissionUrl}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        error: error?.userError ? "user_error" : "error",
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = error?.userError ? 1 : 4;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
