package core

import (
	"database/sql"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestListHistoryFlow_OrdersActionsAndMessages(t *testing.T) {
	db, err := sql.Open("sqlite", "file:historyflow?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	schema := []string{
		`CREATE TABLE incidents (
			id INTEGER PRIMARY KEY, project_name TEXT, name TEXT, status TEXT, severity TEXT,
			error_message TEXT, created_at TEXT, acknowledged_at TEXT, acknowledged_by TEXT,
			mitigated_at TEXT, resolved_at TEXT, resolved_by TEXT, archived INTEGER DEFAULT 0)`,
		`CREATE TABLE incident_comments (
			id INTEGER PRIMARY KEY, incident_id INTEGER, author_username TEXT, body_html TEXT, created_at TEXT)`,
		`CREATE TABLE incident_postmortems (
			incident_id INTEGER PRIMARY KEY, body TEXT, author TEXT, updated_at TEXT)`,
		`CREATE TABLE locator_healings (
			id INTEGER PRIMARY KEY, incident_id INTEGER, agent_source TEXT, original_locator TEXT,
			healed_locator TEXT, explanation TEXT, created_at TEXT)`,
		`CREATE TABLE incident_runbooks (
			id INTEGER PRIMARY KEY, incident_id INTEGER, actor TEXT, template_name TEXT, summary TEXT, created_at TEXT)`,
		`CREATE TABLE healing_patch_submissions (
			id INTEGER PRIMARY KEY, incident_id INTEGER, agent_source TEXT, file_path TEXT, status TEXT,
			explanation TEXT, pr_url TEXT, created_at TEXT)`,
	}
	for _, stmt := range schema {
		if _, err = db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec(`INSERT INTO incidents VALUES
		(7, 'shop', 'Checkout', 'resolved', 'sev2', 'element not found',
		 '2026-10-01 09:00:00', '2026-10-01 09:05:00', 'sami',
		 '', '2026-10-01 10:00:00', 'akr', 0),
		(8, 'other', 'Hidden', 'open', '', 'secret', '2026-10-02 09:00:00', '', '', '', '', '', 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO incident_comments VALUES
		(1, 7, 'akr', '<p>Shard 7 needs a new selector.</p>', '2026-10-01 09:10:00')`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO incident_postmortems VALUES
		(7, 'The button moved.', 'akr', '2026-10-01 10:05:00')`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO locator_healings VALUES
		(1, 7, 'mcp', '[data-testid="old"]', '#ack', 'confirmed on the page', '2026-10-01 09:20:00')`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO incident_runbooks VALUES
		(1, 7, 'sami', 'Page on-call', 'Dry run only', '2026-10-01 09:15:00')`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO healing_patch_submissions VALUES
		(1, 7, 'mcp_agent', 'tests/sample.py', 'accepted', 'Wrote the selector', '', '2026-10-01 09:30:00')`); err != nil {
		t.Fatal(err)
	}

	flow, err := ListHistoryFlow(db, map[string]struct{}{"shop": {}})
	if err != nil {
		t.Fatal(err)
	}
	if len(flow.Incidents) != 1 || flow.Incidents[0].ID != 7 {
		t.Fatalf("incidents = %+v", flow.Incidents)
	}
	kinds := make([]string, 0, len(flow.Incidents[0].Events))
	var comment string
	for _, ev := range flow.Incidents[0].Events {
		kinds = append(kinds, ev.Kind)
		if ev.Kind == "comment" {
			comment = ev.Text
		}
	}
	got := strings.Join(kinds, ",")
	want := "opened,acknowledged,comment,runbook,selector,patch,resolved,postmortem"
	if got != want {
		t.Fatalf("order = %s", got)
	}
	if comment != "Shard 7 needs a new selector." {
		t.Fatalf("comment = %q", comment)
	}
}
