# Contributing an agent

Beekeep is a reviewed registry. Agent snapshots stay in creator-owned public
GitHub repositories; this repository stores only pinned listing metadata.

## Submit a listing

1. Export a config-only `.agent.json` snapshot from Buzz Desktop with memory
   set to **None**.
2. Commit the snapshot and its README to a public GitHub repository.
3. Copy `examples/research-brief.yaml` to
   `agents/<publisher>/<agent>.yaml`.
4. Replace every example value, including the full source commit, exact byte
   size, and SHA-256 digest.
5. Open a pull request and complete the behavioral-change section.

Compute the immutable fields on macOS or Linux:

```bash
git rev-parse HEAD
wc -c < path/to/example.agent.json
shasum -a 256 path/to/example.agent.json
```

The filename must match `slug`. For example, the slug
`alice/research-brief` belongs at
`agents/alice/research-brief.yaml`.

## Safety policy

The MVP accepts JSON agent snapshots only. A submitted snapshot must not
include:

- core or full agent memory;
- private keys, authentication tags, tokens, passwords, or credentials;
- non-empty environment variables;
- executable commands, startup configuration, or hooks.

Validation reduces risk; it does not make an agent trustworthy. Maintainers
review the system prompt, tools, permissions, and source history before merge.

## Validate locally

Node.js 22 or newer is required.

```bash
npm ci --ignore-scripts
npm test
npm run validate
```

`npm run validate:offline` checks listing structure without downloading source
snapshots. The complete check must pass before merge.

## Updates

Any new snapshot requires a new source commit, version, byte size, and SHA-256
digest. Prompt, tool, permission, response-scope, memory, or runtime changes
receive the same manual review as a new listing.

Merging a pull request is the approval and publication event. Maintainers may
suspend a listing when its source disappears, its behavior changes without a
registry update, or a security report is confirmed.
