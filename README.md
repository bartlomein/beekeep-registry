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
packages/cli/                    Published Beekeep submit/install CLI
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

## Submit an agent

Creators only need to:

1. Export a config-only `.agent.json` snapshot from Buzz Desktop with memory
   set to **None**.
2. Commit and push the snapshot plus a short README to a public GitHub
   repository.
3. In that repository, run:

   ```bash
   npx @beekeep-sh/cli submit ./path/to/my-agent.agent.json
   ```

The CLI asks for the agent name, purpose, category, version, and license. It
then verifies the committed and pushed snapshot and opens a pre-filled GitHub
submission page. Confirm the four safety statements and click
**Submit new issue**.

That is the complete creator flow. You do not need to clone this registry,
write YAML, or calculate hashes. Node.js 22 or newer is required. If the CLI
cannot open a browser, it prints the submission URL. The
[submission form](https://github.com/bartlomein/beekeep-registry/issues/new?template=agent-submission.yml)
also remains available for manual use.

Beekeep maintainers resolve the exact source commit and path, calculate the
byte size and SHA-256 digest, run the safety validator, and review the system
prompt, tools, permissions, and source history. Merging the resulting registry
pull request publishes the listing.

## Install an approved agent

The Beekeep CLI is developed in this repository and will be published as
`@beekeep-sh/cli`:

```bash
npx @beekeep-sh/cli add publisher/agent
```

`add` downloads and verifies the approved snapshot, opens Buzz Desktop, and
prints the exact local file path. In Buzz, choose **New agent**, then
**Import agent snapshot**, and select that file. Buzz shows its normal preview
and creates nothing until the user confirms **Import**.

Use `--download-only` to verify and cache a snapshot without opening Buzz.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a listing pull request.
Report validator bypasses or malicious snapshots privately as described in
[SECURITY.md](SECURITY.md).

Validation is a safety gate, not a guarantee. Buzz Desktop's import preview is
the final user approval boundary.
