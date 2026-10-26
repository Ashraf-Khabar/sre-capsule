package core

import (
	"database/sql"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestListUnowned_SkipsOwnedResolvedAndOtherProjects(t *testing.T) {
	db, err := sql.Open("sqlite", "file:unowned?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE incidents (
		id INTEGER PRIMARY KEY, project_name TEXT, name TEXT, status TEXT, severity TEXT,
		error_message TEXT, created_at TEXT, acknowledged_at TEXT, acknowledged_by TEXT,
		is_resolved INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO incidents VALUES
		(1, 'shop', 'Checkout', 'failed', '', 'element not found', '2026-10-25 10:00:00', '', '', 0, 0),
		(6, 'shop', 'Login', 'failed', 'sev2', 'timeout', '2026-10-25 11:30:00', '', '', 0, 0),
		(2, 'shop', 'Owned', 'failed', 'sev1', 'disk', '2026-10-25 09:00:00', '2026-10-25 09:10:00', 'sami', 0, 0),
		(3, 'shop', 'Done', 'resolved', '', 'old', '2026-10-25 08:00:00', '', '', 1, 0),
		(4, 'shop', 'Hidden archive', 'failed', '', 'old', '2026-10-25 08:00:00', '', '', 0, 1),
		(5, 'other', 'Secret', 'failed', '', 'secret', '2026-10-25 07:00:00', '', '', 0, 0)`)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	rows, err := ListUnowned(db, map[string]struct{}{"shop": {}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ID != 1 || rows[1].ID != 6 {
		t.Fatalf("rows = %+v", rows)
	}
	if rows[0].WaitingMin != 120 || rows[1].WaitingMin != 30 {
		t.Fatalf("wait = %d, %d", rows[0].WaitingMin, rows[1].WaitingMin)
	}
	if rows[0].Error != "element not found" || rows[1].Severity != "sev2" {
		t.Fatalf("detail = %+v %+v", rows[0], rows[1])
	}
}
