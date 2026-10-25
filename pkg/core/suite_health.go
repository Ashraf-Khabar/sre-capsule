package core

import (
	"database/sql"
	"encoding/json"
	"sort"
	"strings"
)

// SuiteHealth is the latest pipeline run for one gateway, compared with the
// last green run and the run just before it.
type SuiteHealth struct {
	ProjectName        string          `json:"project_name"`
	Last               SuiteRun        `json:"last"`
	LastGreen          *SuiteRun       `json:"last_green,omitempty"`
	PassRate           int             `json:"pass_rate"`
	NewFailures        []string        `json:"new_failures"`
	FixedSincePrevious []string        `json:"fixed_since_previous"`
	Slowest            []SuiteSlowTest `json:"slowest"`
}

// SuiteRun is the rollup stored for one pipeline execution.
type SuiteRun struct {
	RunID      string `json:"run_id"`
	Outcome    string `json:"outcome"`
	Branch     string `json:"branch,omitempty"`
	StartedAt  string `json:"started_at,omitempty"`
	Passed     int    `json:"passed"`
	Failed     int    `json:"failed"`
	Skipped    int    `json:"skipped"`
	Total      int    `json:"total"`
	DurationMs int64  `json:"duration_ms"`
	Green      bool   `json:"green"`
}

// SuiteSlowTest is one of the slowest cases in the latest run.
type SuiteSlowTest struct {
	Name       string `json:"name"`
	DurationMs int64  `json:"duration_ms"`
	Status     string `json:"status"`
}

type suiteRunRow struct {
	SuiteRun
	Project string
}

// ListSuiteHealth returns one card per gateway the caller can see.
// allowed == nil means every project. An empty map means no access.
func ListSuiteHealth(db *sql.DB, allowed map[string]struct{}, projectFilter string) ([]SuiteHealth, error) {
	if db == nil {
		return nil, sql.ErrConnDone
	}
	rows, err := db.Query(`
		SELECT project_name, pipeline_run_id, COALESCE(outcome,''), COALESCE(branch,''),
		       COALESCE(started_at,''), COALESCE(passed_tests,0), COALESCE(failed_tests,0),
		       COALESCE(skipped_tests,0), COALESCE(total_tests,0), COALESCE(duration_ms,0)
		FROM pipeline_runs
		ORDER BY started_at DESC, id DESC
		LIMIT 400`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byProject := map[string][]suiteRunRow{}
	var order []string
	for rows.Next() {
		var row suiteRunRow
		if err := rows.Scan(&row.Project, &row.RunID, &row.Outcome, &row.Branch, &row.StartedAt,
			&row.Passed, &row.Failed, &row.Skipped, &row.Total, &row.DurationMs); err != nil {
			return nil, err
		}
		row.Green = suiteRunIsGreen(row.SuiteRun)
		if !suiteProjectVisible(row.Project, allowed, projectFilter) {
			continue
		}
		if _, seen := byProject[row.Project]; !seen {
			order = append(order, row.Project)
		}
		if len(byProject[row.Project]) < 12 {
			byProject[row.Project] = append(byProject[row.Project], row)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]SuiteHealth, 0, len(order))
	for _, project := range order {
		runs := byProject[project]
		if len(runs) == 0 {
			continue
		}
		card := SuiteHealth{
			ProjectName:        project,
			Last:               runs[0].SuiteRun,
			NewFailures:        []string{},
			FixedSincePrevious: []string{},
			Slowest:            []SuiteSlowTest{},
		}
		card.PassRate = suitePassRate(card.Last)
		var green *suiteRunRow
		for i := range runs {
			if runs[i].Green {
				green = &runs[i]
				break
			}
		}
		if green != nil {
			copyRun := green.SuiteRun
			card.LastGreen = &copyRun
		}
		currentTests, _ := suiteTests(db, project, card.Last.RunID)
		var baseline []TestCaseResult
		if card.LastGreen != nil && card.LastGreen.RunID != card.Last.RunID {
			baseline, _ = suiteTests(db, project, card.LastGreen.RunID)
		}
		var previous []TestCaseResult
		if len(runs) > 1 {
			previous, _ = suiteTests(db, project, runs[1].RunID)
		}
		card.NewFailures, card.FixedSincePrevious, card.Slowest = diffSuiteTests(currentTests, baseline, previous, card.Last.Green)
		out = append(out, card)
	}
	return out, nil
}

func suiteProjectVisible(project string, allowed map[string]struct{}, filter string) bool {
	filter = strings.TrimSpace(filter)
	if filter != "" && !strings.EqualFold(filter, "all") && project != filter {
		return false
	}
	if allowed == nil {
		return true
	}
	_, ok := allowed[project]
	return ok
}

func suiteRunIsGreen(run SuiteRun) bool {
	if run.Total <= 0 || run.Failed > 0 {
		return false
	}
	outcome := strings.ToLower(strings.TrimSpace(run.Outcome))
	return outcome != "failure" && outcome != "failed" && outcome != "error"
}

func suitePassRate(run SuiteRun) int {
	if run.Total <= 0 {
		return 0
	}
	return int(float64(run.Passed) / float64(run.Total) * 100)
}

func suiteTests(db *sql.DB, project, runID string) ([]TestCaseResult, error) {
	var reportJSON sql.NullString
	err := db.QueryRow(`SELECT report_json FROM pipeline_runs WHERE project_name = ? AND pipeline_run_id = ?`, project, runID).Scan(&reportJSON)
	if err != nil || !reportJSON.Valid || strings.TrimSpace(reportJSON.String) == "" {
		return nil, err
	}
	var report UnifiedExecutionReport
	if json.Unmarshal([]byte(reportJSON.String), &report) != nil {
		return nil, nil
	}
	return report.Tests, nil
}

func diffSuiteTests(current, baseline, previous []TestCaseResult, currentIsGreen bool) (newFailures, fixed []string, slowest []SuiteSlowTest) {
	newFailures = []string{}
	fixed = []string{}
	slowest = []SuiteSlowTest{}
	if !currentIsGreen {
		baseFailed := failedSuiteNames(baseline)
		for _, name := range failedSuiteNames(current).order {
			if _, wasFailing := baseFailed.set[name]; wasFailing {
				continue
			}
			newFailures = append(newFailures, failedSuiteNames(current).label[name])
		}
	}
	prevFailed := failedSuiteNames(previous)
	curFailed := failedSuiteNames(current)
	for _, name := range prevFailed.order {
		if _, still := curFailed.set[name]; still {
			continue
		}
		fixed = append(fixed, prevFailed.label[name])
	}
	if len(newFailures) > 6 {
		newFailures = newFailures[:6]
	}
	if len(fixed) > 6 {
		fixed = fixed[:6]
	}
	type timed struct {
		SuiteSlowTest
	}
	var timedRows []timed
	for _, tc := range current {
		if tc.DurationMs <= 0 || strings.TrimSpace(tc.Name) == "" {
			continue
		}
		timedRows = append(timedRows, timed{SuiteSlowTest{Name: tc.Name, DurationMs: tc.DurationMs, Status: tc.Status}})
	}
	sort.Slice(timedRows, func(i, j int) bool { return timedRows[i].DurationMs > timedRows[j].DurationMs })
	if len(timedRows) > 3 {
		timedRows = timedRows[:3]
	}
	for _, row := range timedRows {
		slowest = append(slowest, row.SuiteSlowTest)
	}
	return newFailures, fixed, slowest
}

type suiteNameSet struct {
	set   map[string]struct{}
	label map[string]string
	order []string
}

func failedSuiteNames(tests []TestCaseResult) suiteNameSet {
	out := suiteNameSet{set: map[string]struct{}{}, label: map[string]string{}}
	for _, tc := range tests {
		if !suiteStatusFailed(tc.Status) {
			continue
		}
		key := normalizeReportName(tc.Name)
		if key == "" {
			key = strings.TrimSpace(tc.Name)
		}
		if _, seen := out.set[key]; seen {
			continue
		}
		out.set[key] = struct{}{}
		label := strings.TrimSpace(tc.Name)
		if label == "" {
			label = key
		}
		out.label[key] = label
		out.order = append(out.order, key)
	}
	return out
}

func suiteStatusFailed(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "fail", "failed", "failure", "flaky", "error":
		return true
	default:
		return false
	}
}
