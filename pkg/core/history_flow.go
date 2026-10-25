package core

import (
	"database/sql"
	"html"
	"strings"
	"time"
	"unicode/utf8"
)

const historyIncidentLimit = 400

// HistoryEvent is one action or message on an incident.
type HistoryEvent struct {
	At    string `json:"at"`
	Kind  string `json:"kind"`
	Actor string `json:"actor,omitempty"`
	Text  string `json:"text"`
}

// HistoryIncident is one failure and the actions recorded on it.
type HistoryIncident struct {
	ID       int            `json:"id"`
	Project  string         `json:"project"`
	Name     string         `json:"name"`
	Status   string         `json:"status,omitempty"`
	Severity string         `json:"severity,omitempty"`
	Archived bool           `json:"archived"`
	Events   []HistoryEvent `json:"events"`
}

// HistoryFlow is the chronological record the history PDF is built from.
type HistoryFlow struct {
	GeneratedAt string            `json:"generated_at"`
	Truncated   bool              `json:"truncated"`
	Incidents   []HistoryIncident `json:"incidents"`
}

// ListHistoryFlow returns the actions and messages the caller can see.
// allowed == nil means every project. An empty map means no access.
func ListHistoryFlow(db *sql.DB, allowed map[string]struct{}) (HistoryFlow, error) {
	flow := HistoryFlow{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Incidents:   []HistoryIncident{},
	}
	if db == nil {
		return flow, sql.ErrConnDone
	}
	if allowed != nil && len(allowed) == 0 {
		return flow, nil
	}

	query := `
		SELECT id, COALESCE(project_name,''), COALESCE(name,''), COALESCE(status,''),
		       COALESCE(severity,''), COALESCE(error_message,''),
		       COALESCE(created_at,''), COALESCE(acknowledged_at,''), COALESCE(acknowledged_by,''),
		       COALESCE(mitigated_at,''), COALESCE(resolved_at,''), COALESCE(resolved_by,''),
		       COALESCE(archived,0)
		FROM incidents`
	var args []any
	if allowed != nil {
		names := make([]string, 0, len(allowed))
		for name := range allowed {
			names = append(names, name)
		}
		placeholders := strings.Repeat("?,", len(names))
		placeholders = strings.TrimSuffix(placeholders, ",")
		query += ` WHERE project_name IN (` + placeholders + `)`
		for _, name := range names {
			args = append(args, name)
		}
	}
	query += ` ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`
	args = append(args, historyIncidentLimit+1)

	rows, err := db.Query(query, args...)
	if err != nil {
		return flow, err
	}
	defer rows.Close()

	var incidents []HistoryIncident
	opened := map[int]HistoryEvent{}
	for rows.Next() {
		var item HistoryIncident
		var errMsg, created, ackedAt, ackedBy, mitigated, resolvedAt, resolvedBy string
		var archived int
		if err := rows.Scan(&item.ID, &item.Project, &item.Name, &item.Status, &item.Severity, &errMsg,
			&created, &ackedAt, &ackedBy, &mitigated, &resolvedAt, &resolvedBy, &archived); err != nil {
			return flow, err
		}
		item.Archived = archived != 0
		item.Events = []HistoryEvent{}
		opened[item.ID] = HistoryEvent{At: created, Kind: "opened", Text: clipText(errMsg, 500)}
		if strings.TrimSpace(ackedAt) != "" || strings.TrimSpace(ackedBy) != "" {
			item.Events = append(item.Events, HistoryEvent{At: ackedAt, Kind: "acknowledged", Actor: ackedBy, Text: "Acknowledged"})
		}
		if strings.TrimSpace(mitigated) != "" {
			item.Events = append(item.Events, HistoryEvent{At: mitigated, Kind: "mitigated", Text: "Mitigated"})
		}
		if strings.TrimSpace(resolvedAt) != "" || strings.TrimSpace(resolvedBy) != "" {
			item.Events = append(item.Events, HistoryEvent{At: resolvedAt, Kind: "resolved", Actor: resolvedBy, Text: "Resolved"})
		}
		incidents = append(incidents, item)
	}
	if err := rows.Err(); err != nil {
		return flow, err
	}
	if len(incidents) > historyIncidentLimit {
		flow.Truncated = true
		incidents = incidents[:historyIncidentLimit]
	}
	if len(incidents) == 0 {
		return flow, nil
	}

	ids := make([]int, len(incidents))
	index := map[int]int{}
	for i, item := range incidents {
		ids[i] = item.ID
		index[item.ID] = i
		ev := opened[item.ID]
		incidents[i].Events = append([]HistoryEvent{ev}, incidents[i].Events...)
	}
	if err := attachHistoryComments(db, ids, index, incidents); err != nil {
		return flow, err
	}
	if err := attachHistoryPostmortems(db, ids, index, incidents); err != nil {
		return flow, err
	}
	if err := attachHistorySelectors(db, ids, index, incidents); err != nil {
		return flow, err
	}
	if err := attachHistoryRunbooks(db, ids, index, incidents); err != nil {
		return flow, err
	}
	if err := attachHistoryPatches(db, ids, index, incidents); err != nil {
		return flow, err
	}
	for i := range incidents {
		sortHistoryEvents(incidents[i].Events)
	}
	flow.Incidents = incidents
	return flow, nil
}

func historyInClause(ids []int) (string, []any) {
	placeholders := strings.Repeat("?,", len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return strings.TrimSuffix(placeholders, ","), args
}

func attachHistoryComments(db *sql.DB, ids []int, index map[int]int, incidents []HistoryIncident) error {
	in, args := historyInClause(ids)
	rows, err := db.Query(`
		SELECT incident_id, COALESCE(author_username,''), COALESCE(body_html,''), COALESCE(created_at,'')
		FROM incident_comments WHERE incident_id IN (`+in+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var author, body, at string
		if err := rows.Scan(&id, &author, &body, &at); err != nil {
			return err
		}
		i, ok := index[id]
		if !ok {
			continue
		}
		incidents[i].Events = append(incidents[i].Events, HistoryEvent{
			At: at, Kind: "comment", Actor: author, Text: clipText(plainHistoryText(body), 4000),
		})
	}
	return rows.Err()
}

func attachHistoryPostmortems(db *sql.DB, ids []int, index map[int]int, incidents []HistoryIncident) error {
	in, args := historyInClause(ids)
	rows, err := db.Query(`
		SELECT incident_id, COALESCE(author,''), COALESCE(body,''), COALESCE(updated_at,'')
		FROM incident_postmortems WHERE incident_id IN (`+in+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var author, body, at string
		if err := rows.Scan(&id, &author, &body, &at); err != nil {
			return err
		}
		i, ok := index[id]
		if !ok {
			continue
		}
		incidents[i].Events = append(incidents[i].Events, HistoryEvent{
			At: at, Kind: "postmortem", Actor: author, Text: clipText(plainHistoryText(body), 4000),
		})
	}
	return rows.Err()
}

func attachHistorySelectors(db *sql.DB, ids []int, index map[int]int, incidents []HistoryIncident) error {
	in, args := historyInClause(ids)
	rows, err := db.Query(`
		SELECT incident_id, COALESCE(agent_source,''), COALESCE(original_locator,''),
		       COALESCE(healed_locator,''), COALESCE(explanation,''), COALESCE(created_at,'')
		FROM locator_healings WHERE incident_id IN (`+in+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var actor, original, healed, explanation, at string
		if err := rows.Scan(&id, &actor, &original, &healed, &explanation, &at); err != nil {
			return err
		}
		i, ok := index[id]
		if !ok {
			continue
		}
		text := strings.TrimSpace(original)
		if healed != "" {
			text += " → " + strings.TrimSpace(healed)
		}
		if note := strings.TrimSpace(explanation); note != "" {
			text += "\n" + note
		}
		incidents[i].Events = append(incidents[i].Events, HistoryEvent{
			At: at, Kind: "selector", Actor: actor, Text: clipText(text, 2000),
		})
	}
	return rows.Err()
}

func attachHistoryRunbooks(db *sql.DB, ids []int, index map[int]int, incidents []HistoryIncident) error {
	in, args := historyInClause(ids)
	rows, err := db.Query(`
		SELECT incident_id, COALESCE(actor,''), COALESCE(template_name,''), COALESCE(summary,''), COALESCE(created_at,'')
		FROM incident_runbooks WHERE incident_id IN (`+in+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var actor, name, summary, at string
		if err := rows.Scan(&id, &actor, &name, &summary, &at); err != nil {
			return err
		}
		i, ok := index[id]
		if !ok {
			continue
		}
		text := strings.TrimSpace(name)
		if summary = strings.TrimSpace(summary); summary != "" {
			if text != "" {
				text += " — "
			}
			text += summary
		}
		incidents[i].Events = append(incidents[i].Events, HistoryEvent{
			At: at, Kind: "runbook", Actor: actor, Text: clipText(text, 2000),
		})
	}
	return rows.Err()
}

func attachHistoryPatches(db *sql.DB, ids []int, index map[int]int, incidents []HistoryIncident) error {
	in, args := historyInClause(ids)
	rows, err := db.Query(`
		SELECT incident_id, COALESCE(agent_source,''), COALESCE(file_path,''), COALESCE(status,''),
		       COALESCE(explanation,''), COALESCE(pr_url,''), COALESCE(created_at,'')
		FROM healing_patch_submissions WHERE incident_id IN (`+in+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var actor, path, status, explanation, pr, at string
		if err := rows.Scan(&id, &actor, &path, &status, &explanation, &pr, &at); err != nil {
			return err
		}
		i, ok := index[id]
		if !ok {
			continue
		}
		parts := []string{}
		if path != "" {
			parts = append(parts, path)
		}
		if status != "" {
			parts = append(parts, status)
		}
		if pr != "" {
			parts = append(parts, pr)
		}
		text := strings.Join(parts, " · ")
		if note := strings.TrimSpace(explanation); note != "" {
			if text != "" {
				text += "\n"
			}
			text += note
		}
		incidents[i].Events = append(incidents[i].Events, HistoryEvent{
			At: at, Kind: "patch", Actor: actor, Text: clipText(text, 2000),
		})
	}
	return rows.Err()
}

func sortHistoryEvents(events []HistoryEvent) {
	rank := map[string]int{
		"opened": 0, "acknowledged": 1, "mitigated": 2, "comment": 3,
		"selector": 4, "runbook": 5, "patch": 6, "postmortem": 7, "resolved": 8,
	}
	for i := 1; i < len(events); i++ {
		item := events[i]
		j := i
		for j > 0 && historyBefore(events[j-1], item, rank) {
			events[j] = events[j-1]
			j--
		}
		events[j] = item
	}
}

func historyBefore(a, b HistoryEvent, rank map[string]int) bool {
	if a.At != b.At {
		return a.At > b.At
	}
	return rank[a.Kind] > rank[b.Kind]
}

func plainHistoryText(raw string) string {
	plain := tagStrip.ReplaceAllString(raw, " ")
	plain = html.UnescapeString(plain)
	return strings.Join(strings.Fields(plain), " ")
}

func clipText(raw string, max int) string {
	raw = strings.TrimSpace(raw)
	if max <= 0 || utf8.RuneCountInString(raw) <= max {
		return raw
	}
	runes := []rune(raw)
	return strings.TrimSpace(string(runes[:max])) + "…"
}
