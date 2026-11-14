# Pre-deploy gate

This branch is the source that reproduces what runs on the Pi (captured 2026-11-14).
Run the gate from the project root before copying any compiled file to the Pi:

    node scripts/predeploy/check.cjs --expect <compiled files this change is meant to alter>

It type-checks `src`, builds into a temporary folder, compares every compiled file with
`production-dist.sha256`, checks that compiled imports resolve, and runs a 7-case smoke
test on the compiled files with voice control enabled. It never contacts the Pi.

- `production-dist.sha256`: exact and whitespace-stripped hash of each production `dist` file.
  `config/web-search.js` in production was spliced by hand: same code, different formatting.
- `production-files.sha256`: hashes of the Python and launcher files as copied from the Pi.
- `imports-baseline.txt`: known non-issues of the import checker (default-export access).
- After a verified deploy, refresh the baseline with `--write-manifest`.

Not in this branch on purpose: `.env*`, `data/`, logs, TV pairing files, `node_modules`, `dist`.
