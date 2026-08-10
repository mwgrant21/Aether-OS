package collector

// Go half of the cross-collector parity harness.
// See test-fixtures/collector-parity/README.md for why this exists.
// The Node half is collector/src/parity.test.ts; neither runs the other,
// they agree by both asserting expected.json.
//
// This lives in package collector rather than package transcript because
// wiring the real anomaly ingester needs both internal/transcript and
// internal/anomaly, and transcript cannot import anomaly (import cycle --
// see scan.go's top doc comment). Using this package's own ingestAnomalies
// adapter also means the harness exercises the same composition the running
// collector uses, not a test-only approximation.

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/mwgrant21/aether-os/collector-go/internal/schema"
	"github.com/mwgrant21/aether-os/collector-go/internal/transcript"
)

type parityTokenTotals struct {
	Input         int64 `json:"input"`
	Output        int64 `json:"output"`
	CacheCreation int64 `json:"cacheCreation"`
	CacheRead     int64 `json:"cacheRead"`
}

type parityGolden struct {
	UsageEvents         int64               `json:"usageEvents"`
	UsageTokenTotals    parityTokenTotals   `json:"usageTokenTotals"`
	ToolCalls           int64               `json:"toolCalls"`
	TranscriptFiles     []string            `json:"transcriptFiles"`
	SchemaVersion       int                 `json:"schemaVersion"`
	ToolCallSourceFiles map[string]string   `json:"toolCallSourceFiles"`
	Columns             map[string][]string `json:"columns"`
}

func fixtureDir(t *testing.T) string {
	t.Helper()
	// collector-go/internal/collector -> repo root
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "test-fixtures", "collector-parity"))
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("parity fixture missing at %s: %v", dir, err)
	}
	return dir
}

func TestCrossCollectorParity(t *testing.T) {
	fixtures := fixtureDir(t)

	raw, err := os.ReadFile(filepath.Join(fixtures, "expected.json"))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var golden parityGolden
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("parse golden: %v", err)
	}

	dir, err := os.MkdirTemp("", "aether-parity-go-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	db, err := schema.OpenDatabase(filepath.Join(dir, "p.db"))
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := schema.Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	corpus := filepath.Join(fixtures, "corpus")
	history := map[string]*transcript.ToolCallHistory{}
	if err := transcript.ScanTranscriptsOnce(db, corpus, 1000, history, ingestAnomalies); err != nil {
		t.Fatalf("ScanTranscriptsOnce: %v", err)
	}

	var rows int64
	var totals parityTokenTotals
	err = db.QueryRow(`SELECT COUNT(*),
	                          COALESCE(SUM(input_tokens), 0),
	                          COALESCE(SUM(output_tokens), 0),
	                          COALESCE(SUM(cache_creation_input_tokens), 0),
	                          COALESCE(SUM(cache_read_input_tokens), 0)
	                   FROM usage_events`).
		Scan(&rows, &totals.Input, &totals.Output, &totals.CacheCreation, &totals.CacheRead)
	if err != nil {
		t.Fatalf("query usage_events: %v", err)
	}

	if rows != golden.UsageEvents {
		t.Errorf("usage_events rows = %d, golden = %d", rows, golden.UsageEvents)
	}
	if totals != golden.UsageTokenTotals {
		t.Errorf("usage token totals = %+v, golden = %+v", totals, golden.UsageTokenTotals)
	}

	var toolCalls int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM tool_calls`).Scan(&toolCalls); err != nil {
		t.Fatalf("query tool_calls: %v", err)
	}
	if toolCalls != golden.ToolCalls {
		t.Errorf("tool_calls rows = %d, golden = %d", toolCalls, golden.ToolCalls)
	}

	// Schema shape. The two collectors migrate the same database, so their
	// schemas must not drift -- issue #31, where this collector sat on
	// version 4 while Node was on 7 and stamped a newer database back down,
	// making Node's next migrate throw on a duplicate column.
	var recorded int
	if err := db.QueryRow(`SELECT value FROM schema_meta WHERE key = 'version'`).Scan(&recorded); err != nil {
		t.Fatalf("read schema version: %v", err)
	}
	if recorded != golden.SchemaVersion {
		t.Errorf("schema version = %d, golden = %d", recorded, golden.SchemaVersion)
	}

	for table, wantCols := range golden.Columns {
		gotCols := queryColumns(t, db, table)
		want := append([]string(nil), wantCols...)
		sort.Strings(want)
		if len(gotCols) != len(want) {
			t.Errorf("%s columns = %v, golden = %v", table, gotCols, want)
			continue
		}
		for i := range gotCols {
			if gotCols[i] != want[i] {
				t.Errorf("%s columns = %v, golden = %v", table, gotCols, want)
				break
			}
		}
	}

	// Per-tool-call source correlation. Row counts alone could not see that
	// this collector left source_file_rel NULL for every row -- issue #32.
	srcRows, err := db.Query(`SELECT tool_use_id, source_file_rel FROM tool_calls`)
	if err != nil {
		t.Fatalf("query tool_calls sources: %v", err)
	}
	gotSources := map[string]string{}
	for srcRows.Next() {
		var id string
		var src sql.NullString
		if err := srcRows.Scan(&id, &src); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if !src.Valid {
			gotSources[id] = "<NULL>"
			continue
		}
		gotSources[id] = strings.ReplaceAll(src.String, string(filepath.Separator), "/")
	}
	srcRows.Close()
	for id, want := range golden.ToolCallSourceFiles {
		if gotSources[id] != want {
			t.Errorf("tool_calls[%s].source_file_rel = %q, golden = %q", id, gotSources[id], want)
		}
	}

	// The load-bearing assertion: both collectors write to the same database,
	// so a file keyed two different ways is scanned twice and double counted.
	// The golden stores forward slashes; normalise this platform's separator.
	got := queryTranscriptFiles(t, db)
	want := append([]string(nil), golden.TranscriptFiles...)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("transcript_files = %v, golden = %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("transcript_files[%d] = %q, golden = %q", i, got[i], want[i])
		}
	}
}

func queryTranscriptFiles(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT file_path FROM transcript_files`)
	if err != nil {
		t.Fatalf("query transcript_files: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, strings.ReplaceAll(p, string(filepath.Separator), "/"))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	sort.Strings(out)
	return out
}

func queryColumns(t *testing.T, db *sql.DB, table string) []string {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatalf("pragma_table_info(%s): %v", table, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
