---
name: Security re-audit
about: The quarterly full-surface security re-audit (opened by security-reaudit.yml)
title: "Quarterly security re-audit YYYY-Qn"
labels: security, type:chore
---

A full-surface re-audit of current `main`, run by a maintainer with Claude Code. The per-PR `/review` audits a diff; this re-examines everything, including packages and ADRs that landed since the last one. #490 holds the prompts, the severity rubric and the confidentiality rules, and each step below names the #490 task it reruns.

- Last re-audit: {{LAST_REAUDIT}}, which audited `main` at `{{LAST_SHA}}`
- This re-audit: `main` at `{{MAIN_SHA}}`

## Confidentiality

- [ ] Findings go only to the private register (`~/.kavo-security/security-findings.md`, never committed) and to draft GitHub security advisories. Critical and High follow #490 Task 8's private advisory loop; Medium and Low follow Task 7's public issue loop.
- [ ] This issue gets a counts-only summary at the end (findings per severity, advisories opened, public issues filed), never a finding's detail.

## What changed since the last re-audit

- [ ] Packages: diff `PACKAGE_DIRS` in `.github/workflows/publish.yml` between `{{LAST_SHA}}` and `{{MAIN_SHA}}`. Every new package gets a full audit in the fan-out below, not a diff audit, and must already be listed in `.claude/agents/kavo-security-auditor.md` (`tests/security-auditor-coverage.spec.ts` enforces this).
- [ ] ADRs: `git diff --stat {{LAST_SHA}} {{MAIN_SHA}} -- docs/internals/adr/`. Record a verdict for each new or amended ADR: security-relevant (and what the fan-out must probe) or not.
- [ ] Config keys, operations and protocol surfaces added since `{{LAST_SHA}}`: note each as a probe target for the fan-out.

## Audit (#490 Tasks 2 to 5, against `{{MAIN_SHA}}`)

- [ ] Task 2, supply chain and release: workflow permissions and action pins, `pnpm audit --prod`, published tarball contents, and the release pipeline.
- [ ] Task 3, core: the query grammar, config resolution, DTO derivation, the engine and error serialization, including #490's mandatory probes.
- [ ] Task 4, adapters and surfaces, dispatched in the same message as Task 3: every ORM adapter, then every protocol, framework and realtime surface, including #490's mandatory probes and every new package in full.
- [ ] Task 5, triage: classify each finding with #490's rubric and check whether it affects the latest release.

## Close-out

- [ ] Update the "What Kavo enforces" and "Known limitations" tables in `docs/guides/security.md` for anything that changed.
- [ ] Post the counts-only summary here and close this issue.
