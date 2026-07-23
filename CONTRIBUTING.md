# Contributing an agent

Beekeep is a reviewed registry. Agent snapshots stay in creator-owned public
GitHub repositories; this repository stores only pinned listing metadata.

## Quick submission

1. Export a config-only `.agent.json` snapshot from Buzz Desktop with memory
   set to **None**.
2. Commit and push the snapshot plus a short README to a public GitHub
   repository.
3. From that repository, run:

   ```bash
   npx @beekeep-sh/cli submit ./path/to/my-agent.agent.json
   ```

Answer the five prompts. The CLI verifies the committed and pushed snapshot,
then opens a pre-filled GitHub page. Confirm the safety statements and click
**Submit new issue**. If the browser does not open, copy the URL printed by the
CLI.

That is the complete creator flow. Node.js 22 or newer is required. The
[submission form](https://github.com/bartlomein/beekeep-registry/issues/new?template=agent-submission.yml)
remains available as a manual fallback. Beekeep maintainers prepare the
registry listing and pull request.

## What Beekeep checks

Maintainers:

- pin the snapshot to one full Git commit and file path;
- calculate and record its exact byte size and SHA-256 digest;
- reject memory, secrets, non-empty environment values, commands, and hooks;
- review the system prompt, tools, permissions, and source history;
- publish the listing only by merging its reviewed registry pull request.

Validation reduces risk; it does not make an agent trustworthy. Maintainers
may reject or suspend a listing that is unsafe, misleading, or no longer
available from its pinned source.

## Advanced or manual contribution

Registry maintainers and contributors can prepare a listing from a local
creator-repository checkout. The snapshot must already be committed and
pushed, and the listing draft must contain the human-authored listing fields:

```bash
npx @beekeep-sh/cli submit ./path/to/example.agent.json \
  --listing ./path/to/listing-draft.yaml \
  --registry /path/to/beekeep-registry
```

The CLI derives the repository, commit, path, byte size, and SHA-256, then
verifies the pinned bytes from GitHub. For a fully manual submission, copy
`examples/research-brief.yaml` to `agents/<publisher>/<agent>.yaml` and replace
every example value. The filename must match `slug`.

Node.js 22 or newer is required to validate a registry checkout:

```bash
npm ci --ignore-scripts
npm test
npm run validate
```

`npm run validate:offline` checks listing structure without downloading source
snapshots. The complete check must pass before merge.

## Updates

Use the same
[agent submission form](https://github.com/bartlomein/beekeep-registry/issues/new?template=agent-submission.yml)
and choose **Update an existing listing**. Describe every prompt, tool,
permission, response-scope, memory, or runtime change. A new snapshot requires
a new source commit, version, byte size, SHA-256 digest, and manual review.
