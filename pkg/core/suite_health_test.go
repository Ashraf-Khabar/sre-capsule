package core

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestDiffSuiteTests_NewSinceGreenAndFixedSincePrevious(t *testing.T) {
	current := []TestCaseResult{
		{Name: "login", Status: "passed", DurationMs: 400},
		{Name: "checkout", Status: "fail", DurationMs: 2200},
		{Name: "slow board", Status: "passed", DurationMs: 9000},
	}
	green := []TestCaseResult{
		{Name: "login", Status: "passed"},
		{Name: "checkout", Status: "passed"},
	}
	previous := []TestCaseResult{
		{Name: "login", Status: "fail"},
		{Name: "checkout", Status: "fail"},
	}
	newFailures, fixed, slowest := diffSuiteTests(current, green, previous, false)
	if len(newFailures) != 1 || newFailures[0] != "checkout" {
		t.Fatalf("new: %#v", newFailures)
	}
	if len(fixed) != 1 || fixed[0] != "login" {
		t.Fatalf("fixed: %#v", fixed)
	}
	if len(slowest) != 3 || slowest[0].Name != "slow board" {
		t.Fatalf("slowest: %#v", slowest)
	}
}

func TestDiffSuiteTests_GreenRunHasNoNewFailures(t *testing.T) {
	current := []TestCaseResult{{Name: "login", Status: "passed", DurationMs: 10}}
	newFailures, _, _ := diffSuiteTests(current, nil, nil, true)
	if len(newFailures) != 0 {
		t.Fatalf("new: %#v", newFailures)
	}
}

func TestListSuiteHealth_ComparesLastRunWithLastGreen(t *testing.T) {
	db, err := sql.Open("sqlite", "file:suitehealth?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE pipeline_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		project_name TEXT, pipeline_run_id TEXT, outcome TEXT, branch TEXT,
		started_at TEXT, passed_tests INT, failed_tests INT, skipped_tests INT,
		total_tests INT, duration_ms INT, report_json TEXT,
		commit_sha TEXT, execution_env TEXT, execution_type TEXT, finished_at TEXT
	)`)
	if err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO pipeline_runs (project_name, pipeline_run_id, outcome, branch, started_at, passed_tests, failed_tests, skipped_tests, total_tests, duration_ms, report_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
	greenReport := `{"tests":[{"name":"login","status":"passed","duration_ms":100},{"name":"checkout","status":"passed","duration_ms":100}]}`
	redReport := `{"tests":[{"name":"login","status":"passed","duration_ms":120},{"name":"checkout","status":"fail","duration_ms":4000}]}`
	if _, err = db.Exec(insert, "shop", "run-green", "success", "main", "2026-10-22 08:00:00", 2, 0, 2, 200, greenReport); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(insert, "shop", "run-red", "failure", "main", "2026-10-23 08:00:00", 1, 1, 2, 4120, redReport); err != nil {
		t.Fatal(err)
	}
	cards, err := ListSuiteHealth(db, nil, "shop")
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 {
		t.Fatalf("cards: %#v", cards)
	}
	card := cards[0]
	if card.Last.RunID != "run-red" || card.PassRate != 50 || card.Last.Green {
		t.Fatalf("last: %+v rate=%d", card.Last, card.PassRate)
	}
	if card.LastGreen == nil || card.LastGreen.RunID != "run-green" {
		t.Fatalf("green: %+v", card.LastGreen)
	}
	if len(card.NewFailures) != 1 || card.NewFailures[0] != "checkout" {
		t.Fatalf("new: %#v", card.NewFailures)
	}
	if card.Slowest[0].Name != "checkout" {
		t.Fatalf("slowest: %#v", card.Slowest)
	}
}
