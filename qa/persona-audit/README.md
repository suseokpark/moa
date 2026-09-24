# FAVMOA 0.1.28 synthetic persona audit

This is a **purposeful synthetic audit**, not a participant study or a browser
session replay. It provides 100 interest contexts, 30 scenario branches and
exactly 3 scenario records per persona. Each branch runs 10 times with varied
content, bookmark/tab source and catalog size.

## Run

From the repository root, use a new output directory for every run:

```sh
node qa/persona-audit/run.mjs artifacts/persona-audit-new-run
```

The command writes `results.json` and `personas.json`, refusing to overwrite an
existing result. A nonzero exit means a contract or harness check failed.
Inspect all failed checks rather than weakening an expected result to obtain a
green run. Do not convert machine duration into human task time.

- `personas.mjs`: explicit interest/goal catalog and coverage assumptions.
- `capture.mjs`: shipped modal handlers, mocked browser candidates, actual reducer.
- `find-organize.mjs`: shipped search/open handlers and real catalog service.
- `model-fixture.mjs`: synthetic catalog and in-memory service adapter.
- `run.mjs`: 300-record ledger with product-source and five-file harness hashes.
- `report.mjs`: HTML report for this audit's screenshots and observations.

The HTML renderer expects the six numbered screenshots from the current audit in
the output directory. It does not capture images or make old screenshots valid
for a later run. For a new product version, recapture the representative flows
and update screenshot notes and priorities before using the renderer.

```sh
node qa/persona-audit/report.mjs artifacts/persona-audit-202609241338/verified/results.json artifacts/persona-audit-202609241338
```

Keep the generated HTML, screenshots and linked `verified/` JSON files together.
Generated results, screenshots and installation artifacts remain ignored by Git.

## Interpret

`contract-pass` means the named implementation expectations matched, not that
the human goal was easy or achieved. A passing record can contain `friction`.
Report unique friction types, affected scenario records and repeated observations
separately. No success rate for people, SUS score, satisfaction or demographic
representativeness can be derived here.

Experience and input mode are context labels only. Capture uses a two-level
destination fixture and expands pagination samples to at least 205 candidates.
Find and organize use the requested collection size and depth. Browser API
permissions, real tab navigation, screen-reader speech, pointer drag/drop, full
contrast/zoom coverage and actual storage quota behavior require separate tests.

The detailed findings and provenance are in
`docs/PERSONA-AUDIT-2026-09-24.md`. Product source and extension version were not
changed as part of this audit.
