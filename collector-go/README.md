# aether-collector-go

A Go port of `../collector/` (the Node headless hook-ingest process), built to be behaviorally
identical to it -- byte-for-byte parity is verified via the golden-file harness in
`scripts/parity/`. See `../docs/roadmap.md` Stage 2 and `../docs/privacy-and-data.md` for the
design rationale shared with the Node collector.

## This coexists with `collector/` -- it does not replace it

`collector/` remains the shipped default. This package exists alongside it so both
implementations can be exercised and compared; nothing in this repo currently switches Aether OS
over to the Go binary. Cutover or retirement of the Node collector is an explicit, separate,
deferred decision -- not part of this stage.

## Build

```
go build -o dist/aether-collector.exe ./cmd/aether-collector
go build -o dist/aether-collector-cli.exe ./cmd/aether-collector-cli
```

Build both binaries into `collector-go/dist/` (not just anywhere): `aether-collector-cli`
resolves its default `-script-path` relative to its own executable location, assuming it sits at
`collector-go/dist/aether-collector-cli.exe` so that `../../scripts/aether-hook-emit.mjs`
resolves to the repo root's `scripts/`. `install-autostart` similarly expects a sibling
`aether-collector.exe` in the same `dist/` directory.

## Shared database

`~/.aether-os/collector.db` is the same SQLite store the Node collector uses. Run only ONE
collector (Node or Go) against a given database at a time.

## Dev loop

```
go build ./...
go vet ./...
go test ./...
```

These are the same commands CI runs (`.github/workflows/ci.yml`, `go-collector` job).

## Parity verification and design history

- `scripts/parity/run-parity.mjs` -- the golden-file harness used to verify this port stays
  behaviorally identical to `collector/`.
- `docs/superpowers/plans/2026-07-30-go-collector-stage10.md` and
  `docs/superpowers/specs/2026-07-30-go-collector-stage10-design.md` -- the full design and
  implementation history for this port.

## Privacy

Same stance as `collector/`: derives a minimal signal from each hook event and never persists raw
command strings, file contents, tool output, or message text. See `../docs/privacy-and-data.md`.
