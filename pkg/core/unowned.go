package core

import (
	"database/sql"
	"strings"
	"time"
)

const unownedLimit = 200

// UnownedIncident is an open incident that nobody has acknowledged.
type UnownedIncident struct {
	ID         int    `json:"id"`
	Project    string `json:"project"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	Severity   string `json:"severity"`
	CreatedAt  string `json:"created_at"`
	WaitingMin int    `json:"waiting_min"`
	Error      string `json:"error"`
}

// ListUnowned returns incidents with no owner. allowed == nil means every project.
// An empty map means no access. Longest wait comes first.
func ListUnowned(db *sql.DB, allowed map[string]struct{}, now time.Time) ([]UnownedIncident, error) {
	if db == nil {
		return nil, sql.ErrConnDone
	}
	if allowed != nil && len(allowed) == 0 {
		return []UnownedIncident{}, nil
	}
	query := `
		SELECT id, COALESCE(project_name,''), COALESCE(name,''), COALESCE(status,''),
		       COALESCE(severity,''), COALESCE(created_at,''), COALESCE(error_message,'')
		FROM incidents
		WHERE COALESCE(archived,0) = 0
		  AND COALESCE(is_resolved,0) = 0
		  AND LOWER(COALESCE(status,'')) NOT IN ('resolved', 'closed')
		  AND TRIM(COALESCE(acknowledged_at,'')) = ''
		  AND TRIM(COALESCE(acknowledged_by,'')) = ''`
	var args []any
	if allowed != nil {
		names := make([]string, 0, len(allowed))
		for name := range allowed {
			names = append(names, name)
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(names)), ",")
		query += ` AND project_name IN (` + placeholders + `)`
		for _, name := range names {
			args = append(args, name)
		}
	}
	query += ` ORDER BY datetime(created_at) ASC, id ASC LIMIT ?`
	args = append(args, unownedLimit)

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []UnownedIncident{}
	for rows.Next() {
		var item UnownedIncident
		if err := rows.Scan(&item.ID, &item.Project, &item.Name, &item.Status, &item.Severity, &item.CreatedAt, &item.Error); err != nil {
			return nil, err
		}
		item.Error = clipText(item.Error, 180)
		item.WaitingMin = waitingMinutes(item.CreatedAt, now)
		out = append(out, item)
	}
	return out, rows.Err()
}

func waitingMinutes(created string, now time.Time) int {
	t, ok := parseIncidentTime(created)
	if !ok || now.Before(t) {
		return 0
	}
	return int(now.Sub(t).Minutes())
}

func parseIncidentTime(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	layouts := []string{
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05",
		time.RFC3339,
	}
	for _, layout := range layouts {
		if t, err := time.ParseInLocation(layout, value, time.UTC); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
