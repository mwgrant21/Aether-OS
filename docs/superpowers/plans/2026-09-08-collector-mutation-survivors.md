# Collector mutation survivors - the remaining worklist

Measured 2026-09-07 against `bf427b0` (before PRs #57-#70), 715 mutants over 8 files,
concurrency 3, zero timeouts. Overall 70.1%. Regenerate with
`collector/stryker.collector.json` - see
[the handoff](./2026-09-08-collector-write-path-hardening.md) for the command and its
three gotchas.

`hookInstaller.ts` and `spoolTailer.ts` are omitted: their survivors were addressed in
PRs #57 and #61-#70, and those two files have moved on considerably since this run.
The files below are unchanged since it, so every line here is still live.

A surviving mutant is a change to the source that the test suite did not notice. Not
all of them are worth killing - error-message text, `err?.message ?? String(err)`
flips and encoding literals are usually equivalent mutants. Judge each one; the ones
worth having are where a wrong *result* would go unnoticed.

---
## src/ingest.ts  (survived 15 / 52)
src/ingest.ts:20  ConditionalExpression -> "false"  |  if (rawLine.trim().length === 0) return null;
src/ingest.ts:20  MethodExpression -> "rawLine"  |  if (rawLine.trim().length === 0) return null;
src/ingest.ts:22  BlockStatement -> "{}"  |  } catch {
src/ingest.ts:32  ConditionalExpression -> "true"  |  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
src/ingest.ts:32  LogicalOperator -> "typeof parsed === 'object' && parsed !== null || !Array.isArray(parse  |  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
src/ingest.ts:32  ConditionalExpression -> "true"  |  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
src/ingest.ts:32  LogicalOperator -> "typeof parsed === 'object' || parsed !== null"  |  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
src/ingest.ts:32  ConditionalExpression -> "true"  |  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
src/ingest.ts:32  ConditionalExpression -> "true"  |  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
src/ingest.ts:34  ConditionalExpression -> "true"  |  const eventName = typeof obj.hook_event_name === 'string' ? obj.hook_event_name : null;
src/ingest.ts:35  ConditionalExpression -> "true"  |  if (eventName !== null && eventName in REQUIRED_FIELDS_BY_EVENT) {
src/ingest.ts:37  ConditionalExpression -> "false"  |  const missing = required.some((field: string) => obj[field] === undefined || obj[field] === null);
src/ingest.ts:76  ConditionalExpression -> "false"  |  if (event === null) return false;
src/ingest.ts:80  BlockStatement -> "{}"  |  } catch {
src/ingest.ts:81  BooleanLiteral -> "true"  |  return false;

## src/promptSafety.ts  (survived 5 / 19)
src/promptSafety.ts:59  ArithmeticOperator -> "content.length - 1"  |  const maxPasses = content.length + 1;
src/promptSafety.ts:60  EqualityOperator -> "pass <= maxPasses"  |  for (let pass = 0; pass < maxPasses; pass += 1) {
src/promptSafety.ts:60  AssignmentOperator -> "pass -= 1"  |  for (let pass = 0; pass < maxPasses; pass += 1) {
src/promptSafety.ts:61  StringLiteral -> "\"Stryker was here!\""  |  const next = out.replace(TAG_RE, '');
src/promptSafety.ts:62  ConditionalExpression -> "false"  |  if (next === out) return out;

## src/retention.ts  (survived 5 / 44)
src/retention.ts:25  ConditionalExpression -> "true"  |  if (staleRows.length > 0) {
src/retention.ts:25  EqualityOperator -> "staleRows.length >= 0"  |  if (staleRows.length > 0) {
src/retention.ts:56  ArrowFunction -> "() => undefined"  |  const distinctDays = new Set(Array.from(groups.values()).map((g) => g.day));
src/retention.ts:72  ConditionalExpression -> "true"  |  if (staleAnomalies.length > 0) {
src/retention.ts:72  EqualityOperator -> "staleAnomalies.length >= 0"  |  if (staleAnomalies.length > 0) {

## src/staleDispatchSweep.ts  (survived 4 / 42)
src/staleDispatchSweep.ts:77  EqualityOperator -> "ageMs > FATAL_TIMEOUT_MS"  |  const timedOut = ageMs >= FATAL_TIMEOUT_MS;
src/staleDispatchSweep.ts:80  EqualityOperator -> "ageMs > SESSION_CHECK_MIN_AGE_MS"  |  if (ageMs >= SESSION_CHECK_MIN_AGE_MS) {
src/staleDispatchSweep.ts:82  ConditionalExpression -> "false"  |  sessionGone = !row || nowMs - row.last_seen_ms > SESSION_STALE_MS;
src/staleDispatchSweep.ts:82  EqualityOperator -> "nowMs - row.last_seen_ms >= SESSION_STALE_MS"  |  sessionGone = !row || nowMs - row.last_seen_ms > SESSION_STALE_MS;

## src/toolCallHistory.ts  (survived 20 / 83)
src/toolCallHistory.ts:36  ConditionalExpression -> "false"  |  if (projectRoot === null || projectRoot === '') return null;
src/toolCallHistory.ts:36  LogicalOperator -> "projectRoot === null && projectRoot === ''"  |  if (projectRoot === null || projectRoot === '') return null;
src/toolCallHistory.ts:36  ConditionalExpression -> "false"  |  if (projectRoot === null || projectRoot === '') return null;
src/toolCallHistory.ts:36  ConditionalExpression -> "false"  |  if (projectRoot === null || projectRoot === '') return null;
src/toolCallHistory.ts:36  StringLiteral -> "\"Stryker was here!\""  |  if (projectRoot === null || projectRoot === '') return null;
src/toolCallHistory.ts:39  ConditionalExpression -> "false"  |  if (rel === '') return null;
src/toolCallHistory.ts:39  StringLiteral -> "\"Stryker was here!\""  |  if (rel === '') return null;
src/toolCallHistory.ts:45  BlockStatement -> "{}"  |  } catch {
src/toolCallHistory.ts:82  OptionalChaining -> "event.timestamp.getTime"  |  const startedAt = event.timestamp?.getTime() ?? nowMs;
src/toolCallHistory.ts:90  ConditionalExpression -> "true"  |  if (open) {
src/toolCallHistory.ts:91  OptionalChaining -> "event.timestamp.getTime"  |  const closedAt = event.timestamp?.getTime() ?? nowMs;
src/toolCallHistory.ts:91  LogicalOperator -> "event.timestamp?.getTime() && nowMs"  |  const closedAt = event.timestamp?.getTime() ?? nowMs;
src/toolCallHistory.ts:104  ConditionalExpression -> "true"  |  if (newEvents.length > HISTORY_MAX_EVENTS) {
src/toolCallHistory.ts:104  EqualityOperator -> "newEvents.length >= HISTORY_MAX_EVENTS"  |  if (newEvents.length > HISTORY_MAX_EVENTS) {
src/toolCallHistory.ts:112  ConditionalExpression -> "false"  |  if (!input || typeof input !== 'object') return null;
src/toolCallHistory.ts:112  LogicalOperator -> "!input && typeof input !== 'object'"  |  if (!input || typeof input !== 'object') return null;
src/toolCallHistory.ts:112  ConditionalExpression -> "false"  |  if (!input || typeof input !== 'object') return null;
src/toolCallHistory.ts:120  ConditionalExpression -> "false"  |  if (!input || typeof input !== 'object') return null;
src/toolCallHistory.ts:120  LogicalOperator -> "!input && typeof input !== 'object'"  |  if (!input || typeof input !== 'object') return null;
src/toolCallHistory.ts:120  ConditionalExpression -> "false"  |  if (!input || typeof input !== 'object') return null;

## src/transcriptScan.ts  (survived 37 / 133)
src/transcriptScan.ts:36  ConditionalExpression -> "false"  |  if (stat.size <= offset) return { lines: [], newOffset: offset };
src/transcriptScan.ts:36  EqualityOperator -> "stat.size < offset"  |  if (stat.size <= offset) return { lines: [], newOffset: offset };
src/transcriptScan.ts:36  ObjectLiteral -> "{}"  |  if (stat.size <= offset) return { lines: [], newOffset: offset };
src/transcriptScan.ts:36  ArrayDeclaration -> "[\"Stryker was here\"]"  |  if (stat.size <= offset) return { lines: [], newOffset: offset };
src/transcriptScan.ts:38  ArithmeticOperator -> "stat.size + offset"  |  const length = stat.size - offset;
src/transcriptScan.ts:45  ConditionalExpression -> "false"  |  if (lastNewline === -1) return { lines: [], newOffset: offset };
src/transcriptScan.ts:45  UnaryOperator -> "+1"  |  if (lastNewline === -1) return { lines: [], newOffset: offset };
src/transcriptScan.ts:45  ObjectLiteral -> "{}"  |  if (lastNewline === -1) return { lines: [], newOffset: offset };
src/transcriptScan.ts:45  ArrayDeclaration -> "[\"Stryker was here\"]"  |  if (lastNewline === -1) return { lines: [], newOffset: offset };
src/transcriptScan.ts:47  ArithmeticOperator -> "offset + Buffer.byteLength(complete, 'utf8') - 1"  |  const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
src/transcriptScan.ts:47  StringLiteral -> "\"\""  |  const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
src/transcriptScan.ts:49  BlockStatement -> "{}"  |  } finally {
src/transcriptScan.ts:60  LogicalOperator -> "durationMs >= 60_000 && toolUses >= 5"  |  return durationMs >= 60_000 || toolUses >= 5;
src/transcriptScan.ts:60  ConditionalExpression -> "false"  |  return durationMs >= 60_000 || toolUses >= 5;
src/transcriptScan.ts:60  EqualityOperator -> "durationMs > 60_000"  |  return durationMs >= 60_000 || toolUses >= 5;
src/transcriptScan.ts:60  ConditionalExpression -> "false"  |  return durationMs >= 60_000 || toolUses >= 5;
src/transcriptScan.ts:60  EqualityOperator -> "toolUses > 5"  |  return durationMs >= 60_000 || toolUses >= 5;
src/transcriptScan.ts:77  MethodExpression -> "readdirSync(projectsRoot, {\n  withFileTypes: true\n})"  |  projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
src/transcriptScan.ts:94  BlockStatement -> "{}"  |  } catch {
src/transcriptScan.ts:113  BlockStatement -> "{}"  |  } catch {
src/transcriptScan.ts:117  MethodExpression -> "lines.map(l => parseTranscriptLine(l))"  |  const parsedEvents = lines
src/transcriptScan.ts:119  ConditionalExpression -> "true"  |  .filter((e): e is NonNullable<typeof e> => e !== null);
src/transcriptScan.ts:152  ConditionalExpression -> "false"  |  if (event.originKind !== 'task-notification') continue;
src/transcriptScan.ts:153  StringLiteral -> "\"Stryker was here!\""  |  const idMatch = (event.humanText || '').match(/<tool-use-id>(.*?)<\/tool-use-id>/);
src/transcriptScan.ts:154  ConditionalExpression -> "false"  |  if (!idMatch) continue;
src/transcriptScan.ts:164  LogicalOperator -> "!row && !row.agent_id"  |  if (!row || !row.agent_id) continue;
src/transcriptScan.ts:164  ConditionalExpression -> "false"  |  if (!row || !row.agent_id) continue;
src/transcriptScan.ts:165  ConditionalExpression -> "false"  |  if (row.exit_state !== 'ok') continue;
src/transcriptScan.ts:173  LogicalOperator -> "row.task_kind && row.agent_id"  |  taskKind: row.task_kind ?? row.agent_id,
src/transcriptScan.ts:199  Regex -> "/\\.jsonl/"  |  const sessionBase = file.replace(/\.jsonl$/, '');
src/transcriptScan.ts:203  MethodExpression -> "readdirSync(subagentsDir)"  |  subagentFiles = readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
src/transcriptScan.ts:203  StringLiteral -> "\"\""  |  subagentFiles = readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
src/transcriptScan.ts:205  ArrayDeclaration -> "[\"Stryker was here\"]"  |  subagentFiles = [];
src/transcriptScan.ts:217  BlockStatement -> "{}"  |  } catch {
src/transcriptScan.ts:220  MethodExpression -> "subLines.map(l => parseTranscriptLine(l))"  |  const subParsedEvents = subLines.map((l) => parseTranscriptLine(l)).filter((e): e is NonNullable<typ
src/transcriptScan.ts:220  ConditionalExpression -> "true"  |  const subParsedEvents = subLines.map((l) => parseTranscriptLine(l)).filter((e): e is NonNullable<typ
src/transcriptScan.ts:237  AssignmentOperator -> "anomaliesIngested -= subAnomalyResult.anomaliesIngested"  |  anomaliesIngested += subAnomalyResult.anomaliesIngested;
