// Package healing implements the self-healing engine for SRE Capsule. It
// classifies test failures into error categories, produces rule-based fix
// suggestions and remediation hints, persists healing records, and exposes
// the data needed by the REST layer to drive the Self-Healing Hub UI.
package healing

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// Service provides framework-agnostic self-healing context (no internal LLM).
type Service struct {
	db *sql.DB
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// ListInsights returns recent unresolved failures that are still open.
func (s *Service) ListInsights(ctx context.Context, projectName string, limit int) ([]InsightRow, error) {
	return s.listInsights(ctx, projectName, limit, false)
}

// ListArchivedInsights returns unresolved failures that were archived.
func (s *Service) ListArchivedInsights(ctx context.Context, projectName string, limit int) ([]InsightRow, error) {
	return s.listInsights(ctx, projectName, limit, true)
}

func (s *Service) listInsights(ctx context.Context, projectName string, limit int, archived bool) ([]InsightRow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("healing service not initialized")
	}
	if limit <= 0 {
		limit = 100
	}
	archivedFlag := 0
	if archived {
		archivedFlag = 1
	}
	q := `
		SELECT id, project_name, name, status, COALESCE(error_message,''), COALESCE(mcp_healed,0), created_at
		FROM incidents
		WHERE is_resolved = 0
		  AND COALESCE(archived, 0) = ?
		  AND UPPER(status) NOT IN ('PASSED', 'PASS', '')`
	args := []interface{}{archivedFlag}
	if projectName != "" {
		q += ` AND project_name = ?`
		args = append(args, projectName)
	}
	q += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []InsightRow
	for rows.Next() {
		var row InsightRow
		var created string
		var errMsg string
		var mcpHealed int
		if err := rows.Scan(&row.IncidentID, &row.ProjectName, &row.TestName, &row.Status, &errMsg, &mcpHealed, &created); err != nil {
			continue
		}
		row.MCPHealed = mcpHealed == 1
		row.ErrorCategory = ClassifyError(errMsg)
		spec := SpecialistFor(row.ErrorCategory, row.TestName, "")
		row.ActiveMCP = spec.ID
		row.ActiveMCPLabel = spec.Label
		row.Summary = spec.Problem
		row.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", created)
		out = append(out, row)
	}
	return out, nil
}

// BuildContext loads incident telemetry and enriches it with healing hints.
func (s *Service) BuildContext(incidentID int64) (*Context, error) {
	inc, err := s.loadIncident(incidentID)
	if err != nil {
		return nil, err
	}
	combined := strings.TrimSpace(inc.ErrorMessage + "\n" + inc.StackTrace)
	category := ClassifyError(combined)
	spec := SpecialistFor(category, inc.TestName, "")
	return &Context{
		IncidentID:       inc.ID,
		ProjectName:      inc.ProjectName,
		TestName:         inc.TestName,
		Status:           inc.Status,
		ErrorMessage:     inc.ErrorMessage,
		StackTrace:       inc.StackTrace,
		ConsoleLogs:      inc.ConsoleLogs,
		Fingerprint:      inc.Fingerprint,
		IdentitySHA256:   identityFingerprint(inc.ProjectName, inc.TestName),
		PipelineRunID:    inc.PipelineRunID,
		ExecutionTimeMs:  inc.ExecutionTimeMs,
		Browser:          inc.Browser,
		OS:               inc.OS,
		Viewport:         inc.Viewport,
		CITags:           s.buildCITags(inc.ProjectName, inc.PipelineRunID, inc.Browser, inc.OS, inc.Viewport),
		CreatedAt:        inc.CreatedAt,
		ErrorCategory:    category,
		ActiveMCP:        spec.ID,
		ActiveMCPLabel:   spec.Label,
		ActiveMCPTool:    spec.Tool,
		Problem:          spec.Problem,
		SelectorHint:     extractSelectorHint(combined),
		SuggestedActions: SuggestedActions(category),
		MCPPrompt:        buildMCPPrompt(incidentID, category),
	}, nil
}

// ProposeFix returns rule-based guidance and optional file echo (MCP agent applies the patch).
func (s *Service) ProposeFix(incidentID int64, fileContent string) (*Proposal, error) {
	ctx, err := s.BuildContext(incidentID)
	if err != nil {
		return nil, err
	}
	code := strings.TrimSpace(fileContent)
	if code == "" {
		// No file content was supplied; return a minimal context comment so
		// callers (AI layer, API handlers) know which incident this pertains to.
		code = "// No source file content available for incident #" + formatInt(incidentID) + " (" + ctx.TestName + ").\n// Provide the test file path in the project settings to enable AI fix proposals."
	}
	return &Proposal{
		Code:             code,
		Explanation:      ctx.Problem,
		ErrorCategory:    ctx.ErrorCategory,
		ActiveMCP:        ctx.ActiveMCP,
		ActiveMCPLabel:   ctx.ActiveMCPLabel,
		ActiveMCPTool:    ctx.ActiveMCPTool,
		Problem:          ctx.Problem,
		SelectorHint:     ctx.SelectorHint,
		SuggestedActions: ctx.SuggestedActions,
		MCPPrompt:        ctx.MCPPrompt,
		Confidence:       confidenceForCategory(ctx.ErrorCategory),
	}, nil
}

func confidenceForCategory(category string) float64 {
	if category == CategoryUnknown {
		return 0.4
	}
	return 0.75
}

// RegisterPatchSubmission persists MCP patch proposal metadata for audit and traceability.
func (s *Service) RegisterPatchSubmission(incidentID int64, repo, filePath, code, explanation, agentSource string) (*PatchSubmission, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("healing service not initialized")
	}
	if incidentID <= 0 {
		return nil, fmt.Errorf("incident_id required")
	}
	repo = strings.TrimSpace(repo)
	filePath = strings.TrimSpace(strings.TrimPrefix(filePath, "/"))
	code = strings.TrimSpace(code)
	if repo == "" || filePath == "" || code == "" {
		return nil, fmt.Errorf("repo, file_path, and code are required")
	}
	explanation = strings.TrimSpace(explanation)
	agentSource = strings.TrimSpace(agentSource)
	if agentSource == "" {
		agentSource = "mcp_agent"
	}
	sum := sha256.Sum256([]byte(code))
	codeHash := hex.EncodeToString(sum[:])
	now := time.Now().UTC()
	res, err := s.db.Exec(
		`INSERT INTO healing_patch_submissions
			(incident_id, repo, file_path, code_sha256, code_size, explanation, agent_source, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
		incidentID, repo, filePath, codeHash, len(code), explanation, agentSource,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &PatchSubmission{
		ID:          id,
		IncidentID:  incidentID,
		Repo:        repo,
		FilePath:    filePath,
		CodeSHA256:  codeHash,
		CodeSize:    len(code),
		Explanation: explanation,
		AgentSource: agentSource,
		Status:      "accepted",
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

// MarkPatchPR links a persisted patch submission to a created PR URL.
func (s *Service) MarkPatchPR(incidentID int64, repo, filePath, code string, prURL string) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("healing service not initialized")
	}
	repo = strings.TrimSpace(repo)
	filePath = strings.TrimSpace(strings.TrimPrefix(filePath, "/"))
	prURL = strings.TrimSpace(prURL)
	if incidentID <= 0 || repo == "" || filePath == "" || prURL == "" {
		return fmt.Errorf("incident_id, repo, file_path and pr_url are required")
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(code)))
	codeHash := hex.EncodeToString(sum[:])
	_, err := s.db.Exec(
		`UPDATE healing_patch_submissions
		 SET status = 'pr_created', pr_url = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE id = (
			 SELECT id FROM healing_patch_submissions
			 WHERE incident_id = ? AND repo = ? AND file_path = ? AND code_sha256 = ?
			 ORDER BY id DESC LIMIT 1
		 )`,
		prURL, incidentID, repo, filePath, codeHash,
	)
	return err
}

// ResolveIncident marks one incident as resolved by actor.
func (s *Service) ResolveIncident(incidentID int64, actor string) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("healing service not initialized")
	}
	actor = strings.TrimSpace(actor)
	if actor == "" {
		actor = "mcp_agent"
	}
	res, err := s.db.Exec(
		"UPDATE incidents SET is_resolved = 1, status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
		actor, incidentID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("incident not found")
	}
	return nil
}
