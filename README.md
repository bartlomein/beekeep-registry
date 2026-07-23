# beekeep-registry

Public, reviewed registry of Buzz agent listings for
[beekeep.sh](https://beekeep.sh).

The registry is an index, not an upload host. Creators keep their
`.agent.json` snapshots in public GitHub repositories. Each approved listing
pins one exact source commit, file path, byte size, and SHA-256 digest.

## Status

The registry contract is at **schema version 1**. Listings are manually
reviewed; merging a pull request publishes the listing.

## Repository layout

```text
agents/<publisher>/<agent>.yaml  Approved and suspended listings
examples/                        Copyable listing examples
schema/listing.schema.json       Strict v1 metadata contract
scripts/validate.mjs             Schema, source, hash, and policy validator
tests/                           Full validator test suite
```

## Listing example

```yaml
schema_version: 1
slug: alice/research-brief
name: Research Brief
summary: Produces a sourced one-page research brief from a focused question.
description: Researches a topic and returns a concise brief with direct links.
category: research
author:
  name: Alice Example
version: 1.0.0
license: MIT
source:
  repository: https://github.com/alice/buzz-agents
  commit: 4b825dc642cb6eb9a060e54bf8d69288fbee4904
  path: research-brief/research-brief.agent.json
snapshot:
  sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  size_bytes: 512
status: approved
```

See [`examples/research-brief.yaml`](examples/research-brief.yaml) for every
supported field.

## Validation

Node.js 22 or newer is required.

```bash
npm ci --ignore-scripts
npm test
npm run validate
```

The complete validator:

1. validates every YAML listing against the strict JSON Schema;
2. requires `agents/<publisher>/<agent>.yaml` to match the listing slug;
3. fetches the snapshot from its pinned GitHub commit;
4. verifies exact byte size and SHA-256;
5. rejects memory, secrets, environment values, commands, and hooks.

Use `npm run validate:offline` when editing metadata without network access.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a listing pull request.
Report validator bypasses or malicious snapshots privately as described in
[SECURITY.md](SECURITY.md).

Validation is a safety gate, not a guarantee. Buzz Desktop's import preview is
the final user approval boundary.
