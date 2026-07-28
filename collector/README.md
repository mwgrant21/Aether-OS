# aether-collector

A standalone, headless Node process that ingests Claude Code hook events into a local SQLite
store. Runs independently of the Aether OS Electron app -- see `docs/roadmap.md` Stage 2 and
`docs/privacy-and-data.md` for the full design rationale.

## Run

```
npm install
npm run build
npm start
```

## Privacy

This process derives a minimal signal from each hook event (file paths, tool names, timestamps,
small counts) and never persists raw command strings, file contents, tool output, or message
text. See `../docs/privacy-and-data.md` for the full policy this process implements.

## Requires

Node.js 22.5 or later (`node:sqlite`).
