package core

import (
	"database/sql"
	"strings"
	"unicode/utf8"
)

// PriorCause is an earlier incident with the same signature.
type PriorCause struct {
	ID             int    `json:"id"`
	Name           string `json:"name"`
	CreatedAt      string `json:"created_at"`
	AcknowledgedBy string `json:"acknowledged_by,omitempty"`
	Severity       string `json:"severity,omitempty"`
	ResolvedBy     string `json:"resolved_by,omitempty"`
	Resolved       bool   `json:"resolved"`
	Postmortem     string `json:"postmortem,omitempty"`
	Change         string `json:"change,omitempty"`
}

// CauseKey identifies one incident on the current dashboard page.
type CauseKey struct {
	ID          int
	Project     string
	Fingerprint string
	Name        string
}

type priorRow struct {
	PriorCause
	Project     string
	Fingerprint string
	NameKey     string
}

// LoadSameCauseHistory returns up to two earlier handled incidents for each key.
// A row counts when it was resolved, acknowledged, has a postmortem, or a saved locator change.
func LoadSameCauseHistory(db *sql.DB, current []CauseKey) map[int][]PriorCause {
	out := map[int][]PriorCause{}
	if db == nil || len(current) == 0 {
		return out
	}
	projects := map[string]struct{}{}
	for _, key := range current {
		if strings.TrimSpace(key.Project) == "" {
			continue
		}
		projects[key.Project] = struct{}{}
	}
	rows := queryPriorRows(db, projects)
	byFP := map[string][]priorRow{}
	byName := map[string][]priorRow{}
	for _, row := range rows {
		if row.Fingerprint != "" {
			byFP[row.Project+"\x00"+row.Fingerprint] = append(byFP[row.Project+"\x00"+row.Fingerprint], row)
		}
		if row.NameKey != "" {
			byName[row.Project+"\x00"+row.NameKey] = append(byName[row.Project+"\x00"+row.NameKey], row)
		}
	}
	for _, key := range current {
		var picked []PriorCause
		if fp := strings.TrimSpace(key.Fingerprint); fp != "" {
			picked = takePriorCauses(byFP[key.Project+"\x00"+fp], key.ID)
		}
		if len(picked) == 0 {
			picked = takePriorCauses(byName[key.Project+"\x00"+causeNameKey(key.Name)], key.ID)
		}
		if len(picked) > 0 {
			out[key.ID] = picked
		}
	}
	return out
}

func takePriorCauses(pool []priorRow, currentID int) []PriorCause {
	var picked []PriorCause
	for _, row := range pool {
		if row.ID == currentID || !priorHasRecord(row.PriorCause) {
			continue
		}
		picked = append(picked, row.PriorCause)
		if len(picked) == 2 {
			break
		}
	}
	return picked
}

func priorHasRecord(p PriorCause) bool {
	return p.Resolved || p.AcknowledgedBy != "" || p.Postmortem != "" || p.Change != ""
}

func queryPriorRows(db *sql.DB, projects map[string]struct{}) []priorRow {
	if len(projects) == 0 {
		return nil
	}
	args := make([]interface{}, 0, len(projects))
	projectPH := placeholders(len(projects), &args, mapKeys(projects))
	q := `SELECT i.id, i.project_name, i.name, COALESCE(i.fingerprint,''),
		COALESCE(i.acknowledged_by,''), COALESCE(i.severity,''), COALESCE(i.resolved_by,''),
		COALESCE(i.is_resolved,0), COALESCE(i.created_at,''),
		COALESCE((SELECT p.body FROM incident_postmortems p WHERE p.incident_id = i.id), ''),
		COALESCE((SELECT CASE
			WHEN COALESCE(h.original_locator,'') != '' AND COALESCE(h.healed_locator,'') != '' THEN h.original_locator || ' → ' || h.healed_locator
			ELSE COALESCE(h.healed_locator,'')
		END FROM locator_healings h
		WHERE h.incident_id = i.id AND COALESCE(h.healed_locator,'') != ''
		ORDER BY h.id DESC LIMIT 1), '')
		FROM incidents i
		WHERE i.project_name IN (` + projectPH + `)
		ORDER BY i.created_at DESC, i.id DESC LIMIT 800`
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []priorRow
	for rows.Next() {
		var row priorRow
		var resolved int
		var body, change string
		if err := rows.Scan(&row.ID, &row.Project, &row.Name, &row.Fingerprint,
			&row.AcknowledgedBy, &row.Severity, &row.ResolvedBy, &resolved, &row.CreatedAt,
			&body, &change); err != nil {
			continue
		}
		row.Resolved = resolved == 1
		row.Postmortem = excerptText(body, 220)
		row.Change = strings.TrimSpace(change)
		row.NameKey = causeNameKey(row.Name)
		out = append(out, row)
	}
	return out
}

func placeholders(n int, args *[]interface{}, values []string) string {
	parts := make([]string, n)
	for i, value := range values {
		parts[i] = "?"
		*args = append(*args, value)
	}
	return strings.Join(parts, ",")
}

func mapKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	return out
}

func causeNameKey(name string) string {
	n := strings.ToLower(strings.TrimSpace(name))
	n = strings.TrimPrefix(n, "[flaky]")
	return strings.Join(strings.Fields(n), " ")
}

func excerptText(raw string, limit int) string {
	plain := tagStrip.ReplaceAllString(raw, " ")
	plain = strings.Join(strings.Fields(plain), " ")
	if plain == "" || limit <= 0 {
		return plain
	}
	if utf8.RuneCountInString(plain) <= limit {
		return plain
	}
	runes := []rune(plain)
	return strings.TrimSpace(string(runes[:limit])) + "…"
}
