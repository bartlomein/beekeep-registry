#!/usr/bin/env node

import path from "node:path";

import {
  assertListingPath,
  findListingFiles,
  loadListingFile,
  validateRemoteSnapshot,
} from "./lib/registry.mjs";

function parseArguments(argv) {
  const options = {
    fetchRemote: true,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--offline") {
      options.fetchRemote = false;
    } else if (argument === "--file") {
      const file = argv[index + 1];
      if (!file) {
        throw new Error("--file requires a path");
      }
      options.files.push(file);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function indent(value) {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function inline(value, maximumLength = 200) {
  const sanitized = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > maximumLength
    ? `${sanitized.slice(0, maximumLength)}…`
    : sanitized;
}

function printReport(relativePath, listing, report) {
  console.log(`✓ ${relativePath}`);
  console.log(`  source: ${listing.source.repository}@${listing.source.commit}`);
  console.log(`  snapshot: ${report.sha256} (${report.size_bytes} bytes)`);
  console.log(`  memory: ${report.memory}`);
  console.log(`  executable configuration: ${report.executable_configuration}`);
  console.log(`  environment values: ${report.environment_values}`);
  console.log(
    `  respond_to: ${report.respond_to === null ? "not declared" : inline(report.respond_to)}`,
  );
  console.log(
    `  tools: ${report.tools.map((tool) => inline(tool)).join(", ") || "none declared"}`,
  );
  console.log(
    `  skills: ${report.skills.map((skill) => inline(skill)).join(", ") || "none declared"}`,
  );
  console.log(
    `  system prompt: ${report.prompt.characters} chars, SHA-256 ${report.prompt.sha256 ?? "not declared"}`,
  );
  if (report.prompt.preview) {
    console.log("  prompt preview:");
    console.log(indent(report.prompt.preview));
  }
}

async function main() {
  const rootDirectory = process.cwd();
  const options = parseArguments(process.argv.slice(2));
  const files =
    options.files.length > 0
      ? options.files.map((file) => path.resolve(rootDirectory, file))
      : await findListingFiles(rootDirectory);

  if (files.length === 0) {
    console.log("No agent listings found. Registry structure is valid.");
    return;
  }

  const failures = [];

  for (const filePath of files) {
    const relativePath = path.relative(rootDirectory, filePath);
    try {
      const listing = await loadListingFile(filePath);
      assertListingPath(filePath, listing, rootDirectory);

      if (options.fetchRemote) {
        const report = await validateRemoteSnapshot(listing);
        printReport(relativePath, listing, report);
      } else {
        console.log(`✓ ${relativePath} (schema and path only)`);
      }
    } catch (error) {
      failures.push({
        relativePath,
        message: error.message,
      });
    }
  }

  if (failures.length > 0) {
    console.error(`\nValidation failed for ${failures.length} listing(s):`);
    for (const failure of failures) {
      console.error(`- ${failure.relativePath}: ${failure.message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Validation failed: ${error.message}`);
  process.exitCode = 1;
});
