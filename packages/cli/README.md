# `@beekeep-sh/cli`

Install a reviewed Buzz agent:

```bash
npx @beekeep-sh/cli add publisher/agent
```

Prepare a registry listing from a committed public snapshot:

```bash
npx @beekeep-sh/cli submit ./my-agent.agent.json
```

The interactive command asks for the agent name, purpose, category, version,
and license. It verifies the exact committed and pushed snapshot, then opens a
pre-filled GitHub submission page for final review.

Registry maintainers can instead finalize a listing draft:

```bash
npx @beekeep-sh/cli submit ./my-agent.agent.json \
  --listing ./my-agent.yaml \
  --registry /path/to/beekeep-registry
```

`add` verifies the approved listing, pinned commit, byte size, SHA-256, JSON,
and Beekeep safety policy before printing the exact local file path and numbered
manual import steps. It does not open Buzz until the app supports a direct
auto-import handoff. Buzz creates nothing until the user confirms **Import**.

Use `--json` for machine-readable output. Use `--download-only` to omit the
manual import steps.

After a snapshot has been verified and cached, the CLI sends one best-effort
anonymous download event containing only the agent slug, version, source
(`cli`), and timestamp assigned by beekeep.sh. Analytics failure never prevents
the download. Use `--no-analytics`, set `BEEKEEP_DISABLE_ANALYTICS=1`, or set
`DO_NOT_TRACK=1` to opt out.

In advanced mode, `submit` fills the immutable source and snapshot fields from
the creator repository, validates the remote pinned file, and writes the
listing into a registry checkout. It does not commit, push, or open a pull
request.
