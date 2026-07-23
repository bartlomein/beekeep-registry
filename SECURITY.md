# Security policy

## Report a vulnerability

Do not open a public issue for a secret exposure, malicious snapshot, validator
bypass, or compromised listing.

Use the repository's private security-advisory form:

https://github.com/bartlomein/beekeep-registry/security/advisories/new

Include the listing slug, source commit, snapshot hash, observed behavior, and
the smallest safe reproduction. Do not include live credentials.

## Trust model

The registry verifies that a listing points to exact public bytes and applies a
conservative policy check. It does not prove that:

- the system prompt is beneficial;
- a requested tool or permission is safe for every user;
- the creator's future commits are trustworthy;
- an external service used by the agent is secure.

Buzz Desktop's import preview remains the final user approval boundary. Review
the prompt, tools, response scope, and requested access before saving an
imported agent.

## Registry response

Maintainers may mark a listing `suspended` while investigating. Confirmed
malicious or compromised listings can be removed, while Git history preserves
the public audit trail.
