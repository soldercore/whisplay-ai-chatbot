# Pre-deploy gate

This branch is the source that reproduces what runs on the Pi (manifests refreshed from
the Pi on 2026-11-16; see `docs/production-baseline.md`).
Run the gate from the project root before copying any compiled file to the Pi:

    node scripts/predeploy/check.cjs --expect <compiled files this change is meant to alter>

It type-checks `src`, builds into a temporary folder, compares every compiled file with
`production-dist.sha256`, checks that compiled imports resolve, and runs a 7-case smoke
test on the compiled files with voice control enabled. It never contacts the Pi.

- `production-dist.sha256`: exact and whitespace-stripped hash of each `dist` file.
  `config/web-search.js` in production was spliced by hand: same code, different formatting.
  `device/lg-c1-volume.js` is the exception described below.
- `production-files.sha256`: hashes of the Python and launcher files as copied from the Pi.
- `imports-baseline.txt`: known non-issues of the import checker (default-export access).
- After a verified deploy, refresh the baseline with `--write-manifest`.

`production-dist.sha256` holds the Pi's actual hashes for 153 of 154 files. The row for
`device/lg-c1-volume.js` holds the hash of the sanitized build of this branch instead
(the router address is no longer compiled in): **the sanitized build differs from
production for this file by design; the production hash is kept privately.** So
`node scripts/predeploy/check.cjs` passes on this branch without `--expect`.

To check the Pi's actual `dist` against the private production manifest (kept outside the
repository; never commit it), copy the Pi's `dist` to a local folder and run:

    node scripts/predeploy/check.cjs --dist <copy of the Pi's dist> --manifest <private production-dist.sha256>

`--manifest` only changes which manifest is compared; everything else is the same. Without
`--manifest`, the same check against the public manifest reports exactly
`device/lg-c1-volume.js` as differing until the sanitized file is deployed; pass
`--expect device/lg-c1-volume.js` for that case.

Not in this branch on purpose: `.env*`, `data/`, logs, TV pairing files, `node_modules`, `dist`.
