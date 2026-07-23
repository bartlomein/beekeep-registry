import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseDocument } from "yaml";
import schema from "../../schema/listing.schema.json" with { type: "json" };

export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const forbiddenSecretKeys = new Set([
  "access_token",
  "api_key",
  "auth_tag",
  "credential",
  "credentials",
  "nsec",
  "password",
  "private_key",
  "private_key_nsec",
  "refresh_token",
  "secret",
  "token",
]);

const forbiddenExecutableKeys = new Set([
  "acp_command",
  "agent_command",
  "agent_command_override",
  "command",
  "commands",
  "hook",
  "hooks",
  "mcp_command",
  "postinstall",
  "preinstall",
  "startup",
]);

const forbiddenEnvironmentKeys = new Set([
  "env",
  "environment",
  "env_vars",
]);

const secretValuePatterns = [
  /\bnsec1[023456789ac-hj-np-z]{20,}\b/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function normalizeKey(key) {
  return key.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyValue(value) {
  if (value === null || value === undefined || value === false || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

function isEmptyMemory(value) {
  if (isEmptyValue(value)) {
    return true;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "none";
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.entries(value).every(([rawKey, nested]) => {
    const key = normalizeKey(rawKey);
    if (key === "level" || key === "memory_level") {
      return typeof nested === "string" && nested.toLowerCase() === "none";
    }
    if (
      key === "source" ||
      key === "source_pubkey" ||
      key === "memory_source_pubkey"
    ) {
      return typeof nested === "string";
    }
    return isEmptyMemory(nested);
  });
}

function walkValue(value, visitor, segments = []) {
  if (Array.isArray(value)) {
    value.forEach((nested, index) => {
      walkValue(nested, visitor, [...segments, String(index)]);
    });
    return;
  }
  if (!isPlainObject(value)) {
    visitor(value, segments, undefined);
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    visitor(nested, [...segments, key], key);
    walkValue(nested, visitor, [...segments, key]);
  }
}

function formatPath(segments) {
  return segments.join(".");
}

function collectNamedValues(root, wantedKeys) {
  const values = [];
  walkValue(root, (value, _segments, rawKey) => {
    if (!rawKey || !wantedKeys.has(normalizeKey(rawKey))) {
      return;
    }

    if (typeof value === "string") {
      values.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          values.push(item);
        } else if (isPlainObject(item)) {
          const name = item.name ?? item.slug ?? item.id;
          if (typeof name === "string") {
            values.push(name);
          }
        }
      }
      return;
    }

    if (isPlainObject(value)) {
      values.push(...Object.keys(value));
    }
  });

  return [...new Set(values)].sort();
}

function findFirstScalar(root, wantedKey) {
  let result;
  walkValue(root, (value, _segments, rawKey) => {
    if (
      result === undefined &&
      rawKey &&
      normalizeKey(rawKey) === wantedKey &&
      (typeof value === "string" || typeof value === "number")
    ) {
      result = value;
    }
  });
  return result;
}

function promptSummary(snapshot) {
  const prompt = findFirstScalar(snapshot, "system_prompt");
  if (typeof prompt !== "string") {
    return {
      characters: 0,
      sha256: null,
      preview: null,
    };
  }

  const printable = prompt
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();

  return {
    characters: prompt.length,
    sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
    preview: printable.length > 500 ? `${printable.slice(0, 500)}…` : printable,
  };
}

export function inspectSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    throw new Error("snapshot root must be a JSON object");
  }

  const violations = [];

  walkValue(snapshot, (value, segments, rawKey) => {
    if (typeof value === "string") {
      for (const pattern of secretValuePatterns) {
        if (pattern.test(value)) {
          violations.push(
            `${formatPath(segments)} contains a credential-like value`,
          );
          break;
        }
      }
    }

    if (!rawKey) {
      return;
    }

    const key = normalizeKey(rawKey);

    if (
      forbiddenSecretKeys.has(key) ||
      key.endsWith("_secret") ||
      key.endsWith("_password") ||
      key.endsWith("_private_key") ||
      key.endsWith("_credential")
    ) {
      if (!isEmptyValue(value)) {
        violations.push(`${formatPath(segments)} contains secret material`);
      }
    }

    if (forbiddenExecutableKeys.has(key) && !isEmptyValue(value)) {
      violations.push(`${formatPath(segments)} contains executable configuration`);
    }

    if (forbiddenEnvironmentKeys.has(key) && !isEmptyValue(value)) {
      violations.push(`${formatPath(segments)} contains environment values`);
    }

    if (
      key === "memory" ||
      key === "memories" ||
      key === "memory_entries" ||
      key === "core_memory" ||
      key === "memory_level"
    ) {
      if (!isEmptyMemory(value)) {
        violations.push(`${formatPath(segments)} includes agent memory`);
      }
    }
  });

  if (violations.length > 0) {
    throw new Error([...new Set(violations)].join("; "));
  }

  return {
    display_name: findFirstScalar(snapshot, "display_name") ?? null,
    prompt: promptSummary(snapshot),
    respond_to: findFirstScalar(snapshot, "respond_to") ?? null,
    parallelism: findFirstScalar(snapshot, "parallelism") ?? null,
    tools: collectNamedValues(snapshot, new Set(["tools", "tool_names"])),
    skills: collectNamedValues(snapshot, new Set(["skills", "skill_names"])),
    memory: "none",
    executable_configuration: "none",
    environment_values: "none",
  };
}

export function assertListingObject(listing) {
  if (!validateSchema(listing)) {
    const details = validateSchema.errors
      .map((error) => {
        const location = error.instancePath || "/";
        return `${location} ${error.message}`;
      })
      .join("; ");
    throw new Error(`listing schema validation failed: ${details}`);
  }
  return listing;
}

export function expectedListingPath(slug) {
  return path.join("agents", ...slug.split("/")) + ".yaml";
}

export function assertListingPath(filePath, listing, rootDirectory) {
  const relativePath = path
    .relative(rootDirectory, filePath)
    .split(path.sep)
    .join("/");
  const expected = expectedListingPath(listing.slug).split(path.sep).join("/");

  if (relativePath !== expected) {
    throw new Error(
      `listing path must be ${expected} for slug ${listing.slug}; got ${relativePath}`,
    );
  }
}

export function parseListingYaml(contents, sourceName = "listing") {
  const document = parseDocument(contents, {
    prettyErrors: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    throw new Error(
      `${sourceName} is not valid YAML: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  let listing;
  try {
    listing = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`${sourceName} cannot use YAML aliases: ${error.message}`);
  }

  return assertListingObject(listing);
}

export async function loadListingFile(filePath) {
  const contents = await readFile(filePath, "utf8");
  return parseListingYaml(contents, filePath);
}

function repositoryParts(repository) {
  const url = new URL(repository);
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    segments.length !== 2
  ) {
    throw new Error("source.repository must be an HTTPS github.com owner/repo URL");
  }
  return segments;
}

export function rawSnapshotUrl(listing) {
  const [owner, repository] = repositoryParts(listing.source.repository);
  const encodedPath = listing.source.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${listing.source.commit}/${encodedPath}`;
}

async function readLimitedBody(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(
      `remote snapshot is ${declaredLength} bytes; limit is ${maximumBytes}`,
    );
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`remote snapshot exceeds ${maximumBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

export async function downloadRemoteSnapshot(
  listing,
  { fetchImpl = globalThis.fetch } = {},
) {
  const url = rawSnapshotUrl(listing);
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "beekeep-registry-validator/1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `snapshot fetch failed with HTTP ${response.status} for ${url}`,
    );
  }

  const bytes = await readLimitedBody(response, MAX_SNAPSHOT_BYTES);
  if (bytes.length !== listing.snapshot.size_bytes) {
    throw new Error(
      `snapshot size mismatch: listing has ${listing.snapshot.size_bytes}, fetched ${bytes.length}`,
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== listing.snapshot.sha256) {
    throw new Error(
      `snapshot SHA-256 mismatch: listing has ${listing.snapshot.sha256}, fetched ${sha256}`,
    );
  }

  let snapshot;
  try {
    snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`snapshot is not valid UTF-8 JSON: ${error.message}`);
  }

  return {
    bytes,
    report: {
      url,
      size_bytes: bytes.length,
      sha256,
      ...inspectSnapshot(snapshot),
    },
  };
}

export async function validateRemoteSnapshot(listing, options = {}) {
  const { report } = await downloadRemoteSnapshot(listing, options);
  return report;
}

export async function findListingFiles(rootDirectory) {
  const agentsDirectory = path.join(rootDirectory, "agents");
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic links are not allowed under agents/: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        files.push(entryPath);
      } else if (entry.isFile() && entry.name !== ".gitkeep") {
        throw new Error(
          `unexpected file under agents/: ${entryPath}; only YAML listings are allowed`,
        );
      }
    }
  }

  await walk(agentsDirectory);
  return files;
}
