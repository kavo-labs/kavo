# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.21.x  | :white_check_mark: |
| < 0.21  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Kavo, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/kavo-labs/kavo/security/advisories/new) to report them. Please include:

- A description of the vulnerability
- Steps to reproduce
- Affected versions
- Any potential mitigations you've identified

You should receive an initial response within **48 hours**. We will work with you to understand and address the issue before any public disclosure.

## Disclosure Policy

- We will confirm receipt of your report within 48 hours.
- We will provide an estimated timeline for a fix within 7 days.
- We will notify you when the vulnerability has been fixed.
- We ask that you do not publicly disclose the issue until we have had a chance to address it.

## Security Hardening

Kavo includes several built-in security measures:

- **Mass assignment protection** — only declared DTO fields are accepted; generated/primary-key columns are stripped automatically.
- **Filter/sort/select allowlists** — clients can only query fields marked `filterable`, `sortable`, or `selectable`.
- **No raw query exposure** — the query grammar is AST-based and does not concatenate user input into SQL/NoSQL strings.
- **JSON-only responses** — no HTML sink; responses are always `application/json`.

## Scope

This policy applies to the `@kavo/*` packages published on npm. It does not apply to third-party integrations or applications built on top of Kavo.
