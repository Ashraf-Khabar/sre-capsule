package core

import (
	"database/sql"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestLoadSameCauseHistory_ReturnsHandledMatch(t *testing.T) {
	db, err := sql.Open("sqlite", "file:samecause?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	schema := []string{
		`CREATE TABLE incidents (
			id INTEGER PRIMARY KEY,
			project_name TEXT,
			name TEXT,
			fingerprint TEXT,
			acknowledged_by TEXT,
			severity TEXT,
			resolved_by TEXT,
			is_resolved INTEGER,
			created_at TEXT
		)`,
		`CREATE TABLE incident_postmortems (incident_id INTEGER PRIMARY KEY, body TEXT)`,
		`CREATE TABLE locator_healings (
			id INTEGER PRIMARY KEY,
			incident_id INTEGER,
			original_locator TEXT,
			healed_locator TEXT
		)`,
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	_, err = db.Exec(`INSERT INTO incidents (id, project_name, name, fingerprint, acknowledged_by, severity, resolved_by, is_resolved, created_at) VALUES
		(1, 'shop', 'checkout', 'fp-1', 'sami', 'sev2', 'akr', 1, '2026-10-20 09:00:00'),
		(2, 'shop', 'checkout', 'fp-1', '', '', '', 0, '2026-10-23 09:00:00'),
		(3, 'shop', 'checkout', 'fp-1', '', '', '', 0, '2026-10-22 09:00:00'),
		(4, 'shop', 'other', 'fp-2', 'lea', 'sev3', 'lea', 1, '2026-10-21 09:00:00')`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO incident_postmortems (incident_id, body) VALUES (1, '<p>Disk latency on shard 7 was the recorded page.</p>')`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO locator_healings (id, incident_id, original_locator, healed_locator) VALUES (1, 1, '[data-testid="confirm-maintenance-window"]', '#ack-lat-shard-7')`); err != nil {
		t.Fatal(err)
	}

	got := LoadSameCauseHistory(db, []CauseKey{{ID: 2, Project: "shop", Fingerprint: "fp-1", Name: "checkout"}})
	priors := got[2]
	if len(priors) != 1 || priors[0].ID != 1 {
		t.Fatalf("priors: %#v", priors)
	}
	if priors[0].AcknowledgedBy != "sami" || !priors[0].Resolved || priors[0].ResolvedBy != "akr" {
		t.Fatalf("owner: %+v", priors[0])
	}
	if !strings.Contains(priors[0].Postmortem, "shard 7") {
		t.Fatalf("postmortem: %q", priors[0].Postmortem)
	}
	if priors[0].Change != `[data-testid="confirm-maintenance-window"] → #ack-lat-shard-7` {
		t.Fatalf("change: %q", priors[0].Change)
	}
}

func TestLoadSameCauseHistory_MatchesNameWhenFingerprintMissing(t *testing.T) {
	db, err := sql.Open("sqlite", "file:samecause-name?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE incidents (
		id INTEGER PRIMARY KEY, project_name TEXT, name TEXT, fingerprint TEXT,
		acknowledged_by TEXT, severity TEXT, resolved_by TEXT, is_resolved INTEGER, created_at TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE incident_postmortems (incident_id INTEGER PRIMARY KEY, body TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE locator_healings (id INTEGER PRIMARY KEY, incident_id INTEGER, original_locator TEXT, healed_locator TEXT)`); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO incidents (id, project_name, name, fingerprint, acknowledged_by, severity, resolved_by, is_resolved, created_at) VALUES
		(8, 'shop', '[FLAKY] Checkout', '', 'sami', '', 'sami', 1, '2026-10-01 00:00:00'),
		(9, 'shop', 'checkout', '', '', '', '', 0, '2026-10-02 00:00:00')`)
	if err != nil {
		t.Fatal(err)
	}
	got := LoadSameCauseHistory(db, []CauseKey{{ID: 9, Project: "shop", Name: "Checkout", Fingerprint: "fp-other"}})
	if len(got[9]) != 1 || got[9][0].ID != 8 {
		t.Fatalf("name match: %#v", got[9])
	}
}
