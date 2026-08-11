// Package retention is the Go port of collector/src/retention.ts: rolling up
// and deleting stale rows past a fixed 30-day retention window, keyed on the
// schema package (Task 1) for the tables it touches. See
// docs/privacy-and-data.md SS6 -- retention is a privacy control, not a disk
// concern: aggregates survive, event rows age out.
package retention

import (
	"database/sql"
	"time"
)

// RetentionWindowMs mirrors retention.ts's RETENTION_WINDOW_MS: exactly 30
// days, in milliseconds.
const RetentionWindowMs int64 = 30 * 24 * 60 * 60 * 1000

// CompactResult mirrors compact()'s TS return shape.
type CompactResult struct {
	RolledUpDays int
	DeletedRows  int
}

// dayKeyUtc mirrors retention.ts's dayKeyUtc: the UTC calendar day (YYYY-MM-DD)
// containing the given epoch-ms timestamp.
func dayKeyUtc(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02")
}

type staleEventRow struct {
	hookEventName string
	toolName      sql.NullString
	occurredAtMs  int64
}

type eventRollupKey struct {
	day           string
	hookEventName string
	toolName      string
}

type staleAnomalyRow struct {
	kind         string
	detectedAtMs int64
}

type anomalyRollupKey struct {
	day  string
	kind string
}

// Compact rolls up and deletes raw `events` rows older than RetentionWindowMs,
// grouped by UTC day/hook_event_name/tool_name. Aggregate counts survive in
// `daily_rollups`; the underlying rows do not. Idempotent: re-running finds
// nothing left to delete for an already-rolled-up day and leaves its rollup
// row's count unchanged. Mirrors retention.ts's compact() exactly, including
// the fact that drift_log/anomalies/tool_calls/dispatches cleanup all run
// unconditionally, independent of whether `events` had any stale rows this
// cycle (see the "deletes stale drift_log rows even when there are zero
// stale events rows this cycle" regression case ported into this package's
// test file).
//
// The whole cycle runs inside one transaction. Without that, a failure
// between the daily_rollups upsert and the events delete (e.g. a concurrent
// writer causing SQLITE_BUSY on the delete) would leave the rollup row
// incremented while the source rows survive -- the next successful cycle
// re-reads those same rows and double-counts them, which is a real spend/cost
// corruption, not just a flaky test. A transaction makes the claimed
// idempotency actually hold: either the whole cycle lands, or none of it
// does, and the next tick retries cleanly from the same starting state.
func Compact(db *sql.DB, nowMs int64) (CompactResult, error) {
	cutoffMs := nowMs - RetentionWindowMs

	tx, err := db.Begin()
	if err != nil {
		return CompactResult{}, err
	}
	defer tx.Rollback() //nolint:errcheck // no-op once Commit has succeeded

	rows, err := tx.Query(
		`SELECT hook_event_name, tool_name, occurred_at_ms FROM events WHERE occurred_at_ms < ?`,
		cutoffMs,
	)
	if err != nil {
		return CompactResult{}, err
	}
	var staleRows []staleEventRow
	for rows.Next() {
		var r staleEventRow
		if err := rows.Scan(&r.hookEventName, &r.toolName, &r.occurredAtMs); err != nil {
			rows.Close()
			return CompactResult{}, err
		}
		staleRows = append(staleRows, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return CompactResult{}, err
	}
	rows.Close()

	rolledUpDays := 0

	if len(staleRows) > 0 {
		// tool_name is normalized to '' (never NULL) before it reaches
		// daily_rollups: SQLite treats NULL as distinct from every other NULL
		// in a PRIMARY KEY/unique index, so ON CONFLICT(day, hook_event_name,
		// tool_name) never fires for rows with a null tool_name (Stop/
		// Notification events), producing silent duplicate rollup rows. ''
		// is used as the sentinel since it can never collide with a real
		// tool name. The raw `events` table is unaffected -- only this
		// aggregate.
		groupCounts := map[eventRollupKey]int{}
		groupOrder := []eventRollupKey{}
		for _, r := range staleRows {
			toolName := ""
			if r.toolName.Valid {
				toolName = r.toolName.String
			}
			key := eventRollupKey{day: dayKeyUtc(r.occurredAtMs), hookEventName: r.hookEventName, toolName: toolName}
			if _, ok := groupCounts[key]; !ok {
				groupOrder = append(groupOrder, key)
			}
			groupCounts[key]++
		}

		upsert, err := tx.Prepare(
			`INSERT INTO daily_rollups (day, hook_event_name, tool_name, event_count) VALUES (?, ?, ?, ?)
			 ON CONFLICT(day, hook_event_name, tool_name) DO UPDATE SET event_count = event_count + excluded.event_count`,
		)
		if err != nil {
			return CompactResult{}, err
		}
		for _, key := range groupOrder {
			if _, err := upsert.Exec(key.day, key.hookEventName, key.toolName, groupCounts[key]); err != nil {
				upsert.Close()
				return CompactResult{}, err
			}
		}
		upsert.Close()

		if _, err := tx.Exec(`DELETE FROM events WHERE occurred_at_ms < ?`, cutoffMs); err != nil {
			return CompactResult{}, err
		}

		distinctDays := map[string]bool{}
		for _, key := range groupOrder {
			distinctDays[key.day] = true
		}
		rolledUpDays = len(distinctDays)
	}

	// drift_log has no rollup/aggregate step -- it's diagnostic noise, not a
	// metric worth preserving in aggregate, unlike `events`. Deleted
	// unconditionally (NOT nested inside the len(staleRows) > 0 branch
	// above): a sustained fleet-poll failure (fleet.PollFleet) writes one
	// drift_log row per failed 15s poll cycle, so a cycle can have zero stale
	// `events` rows and still have plenty of stale drift_log rows to clear.
	if _, err := tx.Exec(`DELETE FROM drift_log WHERE detected_at_ms < ?`, cutoffMs); err != nil {
		return CompactResult{}, err
	}

	anomRows, err := tx.Query(
		`SELECT kind, detected_at_ms FROM anomalies WHERE detected_at_ms < ?`,
		cutoffMs,
	)
	if err != nil {
		return CompactResult{}, err
	}
	var staleAnomalies []staleAnomalyRow
	for anomRows.Next() {
		var r staleAnomalyRow
		if err := anomRows.Scan(&r.kind, &r.detectedAtMs); err != nil {
			anomRows.Close()
			return CompactResult{}, err
		}
		staleAnomalies = append(staleAnomalies, r)
	}
	if err := anomRows.Err(); err != nil {
		anomRows.Close()
		return CompactResult{}, err
	}
	anomRows.Close()

	if len(staleAnomalies) > 0 {
		anomalyCounts := map[anomalyRollupKey]int{}
		anomalyOrder := []anomalyRollupKey{}
		for _, r := range staleAnomalies {
			key := anomalyRollupKey{day: dayKeyUtc(r.detectedAtMs), kind: r.kind}
			if _, ok := anomalyCounts[key]; !ok {
				anomalyOrder = append(anomalyOrder, key)
			}
			anomalyCounts[key]++
		}

		upsertAnomaly, err := tx.Prepare(
			`INSERT INTO daily_anomaly_rollups (day, kind, anomaly_count) VALUES (?, ?, ?)
			 ON CONFLICT(day, kind) DO UPDATE SET anomaly_count = anomaly_count + excluded.anomaly_count`,
		)
		if err != nil {
			return CompactResult{}, err
		}
		for _, key := range anomalyOrder {
			if _, err := upsertAnomaly.Exec(key.day, key.kind, anomalyCounts[key]); err != nil {
				upsertAnomaly.Close()
				return CompactResult{}, err
			}
		}
		upsertAnomaly.Close()

		if _, err := tx.Exec(`DELETE FROM anomalies WHERE detected_at_ms < ?`, cutoffMs); err != nil {
			return CompactResult{}, err
		}
	}

	// tool_calls/dispatches: unconditional deletion, no rollup -- these are a
	// recent-activity view, not an audit log worth aggregating.
	if _, err := tx.Exec(`DELETE FROM tool_calls WHERE closed_at_ms < ?`, cutoffMs); err != nil {
		return CompactResult{}, err
	}
	if _, err := tx.Exec(`DELETE FROM dispatches WHERE ended_at_ms < ?`, cutoffMs); err != nil {
		return CompactResult{}, err
	}

	if err := tx.Commit(); err != nil {
		return CompactResult{}, err
	}

	return CompactResult{RolledUpDays: rolledUpDays, DeletedRows: len(staleRows)}, nil
}
