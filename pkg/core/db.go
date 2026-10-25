package core

import (
	"database/sql"
	"log"
	"path/filepath"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite" // SQLite driver
)

// Global database connection pool
var DB *sql.DB

// InitDB initializes the SQLite database under DataDir() (see SRECAPSULE_DATA_DIR).
func InitDB(ignoredPath string) {
	dbPath := DBFilePath()

	// Print the exact absolute path to the terminal for verification
	absPath, _ := filepath.Abs(dbPath)
	log.Printf("[INFO] Initializing SQLite database at: %s", absPath)

	var err error
	// 4. Open the SQLite database
	DB, err = sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatalf("[FATAL] Failed to open SQLite database: %v", err)
	}

	// Several screens read at once (dashboard, report, comments). One connection
	// deadlocks the pool when a handler starts a second query. WAL still serializes writes.
	DB.SetMaxOpenConns(8)
	DB.SetMaxIdleConns(4)
	DB.SetConnMaxLifetime(time.Hour)

	_, err = DB.Exec("PRAGMA journal_mode=WAL;")
	if err != nil {
		log.Printf("[WARNING] Could not enable WAL mode: %v", err)
	}
	DB.Exec("PRAGMA busy_timeout=30000;")
	DB.Exec("PRAGMA synchronous=NORMAL;")

	// 5. Force a connection to ensure the physical file is actually created right now
	if err = DB.Ping(); err != nil {
		log.Fatalf("[FATAL] Failed to ping database: %v", err)
	}

	// 1. Create global users table (IAM)
	createUsersTable := `
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		fullname TEXT,
		password_hash TEXT NOT NULL,
		role TEXT DEFAULT 'observer',
		is_active INTEGER DEFAULT 1,
		require_password_change INTEGER DEFAULT 1
	);`
	_, err = DB.Exec(createUsersTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create users table: %v", err)
	}

	// 2. Create hierarchical teams table (Organizations)
	createTeamsTable := `
	CREATE TABLE IF NOT EXISTS teams (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT UNIQUE NOT NULL,
		parent_id INTEGER,
		FOREIGN KEY(parent_id) REFERENCES teams(id) ON DELETE CASCADE
	);`
	_, err = DB.Exec(createTeamsTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create teams table: %v", err)
	}

	// 3. Create mapping table for Granular RBAC (Users <-> Teams)
	createUserTeamsTable := `
	CREATE TABLE IF NOT EXISTS user_teams (
		user_id INTEGER,
		team_id INTEGER,
		team_role TEXT DEFAULT 'team_viewer',
		PRIMARY KEY (user_id, team_id),
		FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
	);`
	_, err = DB.Exec(createUserTeamsTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create user_teams table: %v", err)
	}

	// 4. Create projects table (CI/CD Gateways mapped to Teams)
	createProjectsTable := `
	CREATE TABLE IF NOT EXISTS projects (
		id TEXT PRIMARY KEY,
		name TEXT UNIQUE NOT NULL,
		team_id INTEGER NOT NULL,
		ci_system TEXT,
		repo_path TEXT,
		api_key TEXT UNIQUE NOT NULL,
		slack_channel TEXT,
		jira_project_key TEXT,
		teams_webhook TEXT,
		FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
	);`
	_, err = DB.Exec(createProjectsTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create projects table: %v", err)
	}

	// 5. Create incidents table
	createIncidentsTable := `
	CREATE TABLE IF NOT EXISTS incidents (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		project_name TEXT,
		name TEXT,
		status TEXT,
		error_message TEXT,
		console_logs TEXT,
		error_logs TEXT, 
		fingerprint TEXT, 
		is_resolved INTEGER DEFAULT 0,
		resolved_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		resolved_at DATETIME
	);`
	_, err = DB.Exec(createIncidentsTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create incidents table: %v", err)
	}

	// 6. Create index for Smart Correlation
	createIndex := `CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents(fingerprint, is_resolved);`
	_, err = DB.Exec(createIndex)
	if err != nil {
		log.Printf("[WARNING] Failed to create index for fingerprint: %v", err)
	}

	createFinOpsTable := `
	CREATE TABLE IF NOT EXISTS finops_settings (
		id INTEGER PRIMARY KEY,
		dev_hourly_rate REAL,
		ci_minute_cost REAL,
		avg_pipeline_duration REAL,
		avg_investigation_time REAL,
		currency TEXT DEFAULT 'USD'
	);`
	_, err = DB.Exec(createFinOpsTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create finops_settings table: %v", err)
	}

	createUserPreferencesTable := `
	CREATE TABLE IF NOT EXISTS user_preferences (
		user_id INTEGER PRIMARY KEY,
		prefs_json TEXT NOT NULL DEFAULT '{}',
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
	);`
	_, err = DB.Exec(createUserPreferencesTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create user_preferences table: %v", err)
	}

	createSavedChartsTable := `
	CREATE TABLE IF NOT EXISTS saved_charts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		description TEXT DEFAULT '',
		qcl_query TEXT NOT NULL,
		pin_dashboard INTEGER DEFAULT 0,
		pin_finops INTEGER DEFAULT 0,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);`
	_, err = DB.Exec(createSavedChartsTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create saved_charts table: %v", err)
	}

	// Create Enterprise License Config Table
	createEnterpriseTable := `
	CREATE TABLE IF NOT EXISTS enterprise_config (
		id INTEGER PRIMARY KEY,
		license_key TEXT
	);`
	_, err = DB.Exec(createEnterpriseTable)
	if err != nil {
		log.Fatalf("[FATAL] Failed to create enterprise_config table: %v", err)
	}

	runSchemaMigrations()

	log.Println("[INFO] Database initialized successfully with Smart Correlation schema.")
	seedInitialData()
}

func runSchemaMigrations() {
	// Column upgrades (idempotent — skipped when column already exists).
	columnMigrations := []struct {
		table  string
		column string
		sql    string
	}{
		{"user_teams", "inherited_from", `ALTER TABLE user_teams ADD COLUMN inherited_from INTEGER DEFAULT NULL`},
		{"incidents", "pipeline_run_id", `ALTER TABLE incidents ADD COLUMN pipeline_run_id TEXT DEFAULT ''`},
		{"incidents", "acknowledged_at", `ALTER TABLE incidents ADD COLUMN acknowledged_at DATETIME`},
		{"incidents", "acknowledged_by", `ALTER TABLE incidents ADD COLUMN acknowledged_by TEXT DEFAULT ''`},
		{"incidents", "severity", `ALTER TABLE incidents ADD COLUMN severity TEXT DEFAULT ''`},
		{"incidents", "mitigated_at", `ALTER TABLE incidents ADD COLUMN mitigated_at DATETIME`},
		{"incidents", "browser", `ALTER TABLE incidents ADD COLUMN browser TEXT DEFAULT ''`},
		{"incidents", "os", `ALTER TABLE incidents ADD COLUMN os TEXT DEFAULT ''`},
		{"incidents", "viewport", `ALTER TABLE incidents ADD COLUMN viewport TEXT DEFAULT ''`},
		{"incidents", "execution_time_ms", `ALTER TABLE incidents ADD COLUMN execution_time_ms INTEGER`},
		{"incidents", "jira_issue_key", `ALTER TABLE incidents ADD COLUMN jira_issue_key TEXT DEFAULT ''`},
		{"projects", "sre_routing_json", `ALTER TABLE projects ADD COLUMN sre_routing_json TEXT DEFAULT '[]'`},
		{"projects", "sre_workflow_json", `ALTER TABLE projects ADD COLUMN sre_workflow_json TEXT DEFAULT ''`},
		{"projects", "slo_failure_rate", `ALTER TABLE projects ADD COLUMN slo_failure_rate REAL DEFAULT 0.15`},
		{"incidents", "rca_status", `ALTER TABLE incidents ADD COLUMN rca_status TEXT DEFAULT ''`},
		{"incidents", "has_rca", `ALTER TABLE incidents ADD COLUMN has_rca INTEGER DEFAULT 0`},
		{"incidents", "archived", `ALTER TABLE incidents ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`},
		{"pipeline_runs", "outcome", `ALTER TABLE pipeline_runs ADD COLUMN outcome TEXT DEFAULT 'unknown'`},
		{"pipeline_runs", "finished_at", `ALTER TABLE pipeline_runs ADD COLUMN finished_at DATETIME`},
		{"pipeline_runs", "execution_env", `ALTER TABLE pipeline_runs ADD COLUMN execution_env TEXT DEFAULT 'UNKNOWN'`},
		{"pipeline_runs", "execution_type", `ALTER TABLE pipeline_runs ADD COLUMN execution_type TEXT DEFAULT 'REAL'`},
		{"pipeline_runs", "total_tests", `ALTER TABLE pipeline_runs ADD COLUMN total_tests INTEGER DEFAULT 0`},
		{"pipeline_runs", "passed_tests", `ALTER TABLE pipeline_runs ADD COLUMN passed_tests INTEGER DEFAULT 0`},
		{"pipeline_runs", "failed_tests", `ALTER TABLE pipeline_runs ADD COLUMN failed_tests INTEGER DEFAULT 0`},
		{"pipeline_runs", "skipped_tests", `ALTER TABLE pipeline_runs ADD COLUMN skipped_tests INTEGER DEFAULT 0`},
		{"pipeline_runs", "duration_ms", `ALTER TABLE pipeline_runs ADD COLUMN duration_ms INTEGER DEFAULT 0`},
		{"pipeline_runs", "report_json", `ALTER TABLE pipeline_runs ADD COLUMN report_json TEXT DEFAULT '{}'`},
	}
	for _, m := range columnMigrations {
		addColumnIfNotExists(m.table, m.column, m.sql)
	}

	ddlMigrations := []string{
		`CREATE TABLE IF NOT EXISTS incident_artifacts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id INTEGER NOT NULL,
			file_name TEXT NOT NULL,
			content_type TEXT,
			size_bytes INTEGER NOT NULL,
			storage_provider TEXT NOT NULL DEFAULT 'local',
			storage_path TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(incident_id) REFERENCES incidents(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_incident_artifacts_incident ON incident_artifacts(incident_id)`,
		`CREATE TABLE IF NOT EXISTS test_execution_metrics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_name TEXT NOT NULL,
			test_name TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			execution_time_ms INTEGER NOT NULL,
			status TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_test_metrics_fp ON test_execution_metrics(project_name, fingerprint, created_at)`,
		`CREATE TABLE IF NOT EXISTS ai_provider_config (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			provider TEXT NOT NULL DEFAULT 'disabled',
			model TEXT NOT NULL DEFAULT '',
			base_url TEXT DEFAULT '',
			api_key_env TEXT DEFAULT 'OPENAI_API_KEY',
			max_tokens INTEGER DEFAULT 1024,
			timeout_seconds INTEGER DEFAULT 45,
			enabled INTEGER DEFAULT 0,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT OR IGNORE INTO ai_provider_config (id, provider, enabled) VALUES (1, 'disabled', 0)`,
		`CREATE TABLE IF NOT EXISTS ai_analysis_jobs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id INTEGER NOT NULL UNIQUE,
			status TEXT NOT NULL DEFAULT 'pending',
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			prompt_version TEXT NOT NULL DEFAULT 'rca-v1',
			error_message TEXT DEFAULT '',
			started_at DATETIME,
			completed_at DATETIME,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(incident_id) REFERENCES incidents(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_analysis_jobs(status)`,
		`CREATE TABLE IF NOT EXISTS incident_rca_reports (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id INTEGER NOT NULL UNIQUE,
			summary TEXT NOT NULL,
			root_cause TEXT DEFAULT '',
			suggested_fix TEXT DEFAULT '',
			selector_hint TEXT DEFAULT '',
			confidence REAL DEFAULT 0,
			raw_response_json TEXT DEFAULT '',
			tokens_input INTEGER DEFAULT 0,
			tokens_output INTEGER DEFAULT 0,
			latency_ms INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(incident_id) REFERENCES incidents(id) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS pipeline_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_name TEXT NOT NULL,
			pipeline_run_id TEXT NOT NULL,
			commit_sha TEXT DEFAULT '',
			branch TEXT DEFAULT '',
			outcome TEXT DEFAULT 'unknown',
			started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			finished_at DATETIME,
			execution_env TEXT DEFAULT 'UNKNOWN',
			execution_type TEXT DEFAULT 'REAL',
			total_tests INTEGER DEFAULT 0,
			passed_tests INTEGER DEFAULT 0,
			failed_tests INTEGER DEFAULT 0,
			skipped_tests INTEGER DEFAULT 0,
			duration_ms INTEGER DEFAULT 0,
			report_json TEXT DEFAULT '{}',
			UNIQUE(project_name, pipeline_run_id)
		)`,
		`CREATE TABLE IF NOT EXISTS test_stability_stats (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_name TEXT NOT NULL,
			test_identity_fingerprint TEXT NOT NULL,
			test_name TEXT NOT NULL,
			total_runs INTEGER DEFAULT 0,
			fail_count INTEGER DEFAULT 0,
			pass_count INTEGER DEFAULT 0,
			flaky_count INTEGER DEFAULT 0,
			last_status TEXT DEFAULT '',
			last_commit_sha TEXT DEFAULT '',
			last_pipeline_run_id TEXT DEFAULT '',
			consecutive_failures INTEGER DEFAULT 0,
			last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(project_name, test_identity_fingerprint)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_stability_project ON test_stability_stats(project_name, last_seen_at)`,
		`CREATE TABLE IF NOT EXISTS test_quarantine_entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_name TEXT NOT NULL,
			test_identity_fingerprint TEXT NOT NULL,
			test_name TEXT NOT NULL,
			reason TEXT NOT NULL DEFAULT 'flaky',
			source TEXT NOT NULL DEFAULT 'auto',
			incident_id INTEGER,
			commit_sha_at_quarantine TEXT DEFAULT '',
			expires_at DATETIME,
			is_active INTEGER DEFAULT 1,
			created_by TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			lifted_at DATETIME,
			lifted_by TEXT DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_quarantine_active ON test_quarantine_entries(project_name, is_active)`,
		`CREATE TABLE IF NOT EXISTS test_state_transitions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_name TEXT NOT NULL,
			test_identity_fingerprint TEXT NOT NULL,
			pipeline_run_id TEXT DEFAULT '',
			commit_sha TEXT DEFAULT '',
			from_status TEXT,
			to_status TEXT NOT NULL,
			incident_fingerprint TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_transitions_fp ON test_state_transitions(project_name, test_identity_fingerprint, created_at)`,
		`CREATE TABLE IF NOT EXISTS external_signals (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_name TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT 'prometheus',
			signal_name TEXT NOT NULL,
			severity TEXT DEFAULT 'warning',
			labels_json TEXT DEFAULT '{}',
			summary TEXT DEFAULT '',
			fired_at DATETIME NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_external_signals_project ON external_signals(project_name, fired_at)`,
		`CREATE TABLE IF NOT EXISTS external_signal_correlations (
			signal_id INTEGER NOT NULL,
			incident_id INTEGER NOT NULL,
			PRIMARY KEY (signal_id, incident_id),
			FOREIGN KEY(signal_id) REFERENCES external_signals(id) ON DELETE CASCADE,
			FOREIGN KEY(incident_id) REFERENCES incidents(id) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS healing_patch_submissions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id INTEGER NOT NULL,
			repo TEXT NOT NULL,
			file_path TEXT NOT NULL,
			code_sha256 TEXT NOT NULL,
			code_size INTEGER NOT NULL DEFAULT 0,
			explanation TEXT DEFAULT '',
			agent_source TEXT DEFAULT 'mcp_agent',
			status TEXT NOT NULL DEFAULT 'accepted',
			pr_url TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(incident_id) REFERENCES incidents(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_healing_patch_incident ON healing_patch_submissions(incident_id, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS locator_healings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id INTEGER NOT NULL,
			run_id TEXT NOT NULL DEFAULT '',
			framework TEXT NOT NULL DEFAULT '',
			original_locator TEXT NOT NULL DEFAULT '',
			healed_locator TEXT DEFAULT '',
			confidence REAL DEFAULT 0,
			explanation TEXT DEFAULT '',
			agent_source TEXT DEFAULT 'mcp_gate',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(incident_id) REFERENCES incidents(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_locator_healings_run ON locator_healings(run_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_locator_healings_incident ON locator_healings(incident_id)`,
		`CREATE TABLE IF NOT EXISTS incident_comments (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id INTEGER NOT NULL,
			parent_id INTEGER,
			author_username TEXT NOT NULL,
			body_html TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_incident_comments_incident ON incident_comments(incident_id, id)`,
		`CREATE TABLE IF NOT EXISTS incident_runbooks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id INTEGER NOT NULL,
			template_id TEXT NOT NULL,
			template_name TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL DEFAULT '',
			actor TEXT NOT NULL DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_incident_runbooks_incident ON incident_runbooks(incident_id, id DESC)`,
		`CREATE TABLE IF NOT EXISTS incident_postmortems (
			incident_id INTEGER PRIMARY KEY,
			body TEXT NOT NULL,
			author TEXT NOT NULL DEFAULT '',
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS gateway_maintenance (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_name TEXT NOT NULL,
			reason TEXT NOT NULL DEFAULT '',
			starts_at DATETIME NOT NULL,
			ends_at DATETIME NOT NULL,
			created_by TEXT NOT NULL DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_gateway_maintenance_active ON gateway_maintenance(project_name, ends_at)`,
		`CREATE TABLE IF NOT EXISTS user_team_inheritance_optouts (
			user_id INTEGER NOT NULL,
			team_id INTEGER NOT NULL,
			ancestor_team_id INTEGER NOT NULL,
			PRIMARY KEY (user_id, team_id, ancestor_team_id),
			FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
			FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
		)`,
	}
	for _, sqlStmt := range ddlMigrations {
		execSchemaSQL(sqlStmt)
	}
	// Legacy DBs: pipeline_runs created before branch was in CREATE TABLE.
	addColumnIfNotExists("incident_comments", "parent_id", `ALTER TABLE incident_comments ADD COLUMN parent_id INTEGER`)
	addColumnIfNotExists("users", "avatar_kind", `ALTER TABLE users ADD COLUMN avatar_kind TEXT DEFAULT ''`)
	addColumnIfNotExists("users", "avatar_value", `ALTER TABLE users ADD COLUMN avatar_value TEXT DEFAULT ''`)
	addColumnIfNotExists("pipeline_runs", "branch", `ALTER TABLE pipeline_runs ADD COLUMN branch TEXT DEFAULT ''`)
	// MCP self-healing: mark incidents where a locator intervention was recorded.
	addColumnIfNotExists("incidents", "mcp_healed", `ALTER TABLE incidents ADD COLUMN mcp_healed INTEGER NOT NULL DEFAULT 0`)
	migrateGlobalRoleCodes()
}

func migrateGlobalRoleCodes() {
	if _, err := DB.Exec(`UPDATE users SET role = 'lead' WHERE role = 'operator'`); err != nil {
		log.Printf("[INFO] Role migration (operator→lead): %v", err)
	}
	if _, err := DB.Exec(`UPDATE users SET role = lower(trim(role)) WHERE role != lower(trim(role))`); err != nil {
		log.Printf("[WARNING] Could not normalize user roles: %v", err)
	}
	if _, err := DB.Exec(`UPDATE users SET role = 'observer' WHERE role = 'viewer'`); err != nil {
		log.Printf("[INFO] Role migration (viewer→observer): %v", err)
	}
}

func seedInitialData() {
	var teamCount int
	DB.QueryRow("SELECT COUNT(*) FROM teams").Scan(&teamCount)
	if teamCount == 0 {
		_, err := DB.Exec("INSERT INTO teams (id, name, parent_id) VALUES (1, 'Root Organization', NULL)")
		if err != nil {
			log.Printf("[WARNING] Could not seed root team: %v", err)
		} else {
			log.Println("[INFO] Default 'Root Organization' created.")
		}
	}

	var userCount int
	DB.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount)
	if userCount == 0 {
		hashedPassword, _ := bcrypt.GenerateFromPassword([]byte("admin"), bcrypt.DefaultCost)
		_, err := DB.Exec(`INSERT INTO users (username, fullname, password_hash, role, is_active, require_password_change) 
			VALUES ('admin', 'Platform Administrator', ?, 'admin', 1, 1)`, string(hashedPassword))
		if err != nil {
			log.Printf("[WARNING] Could not seed admin user: %v", err)
		} else {
			log.Println("[INFO] Default 'admin' user created (password: admin). Please change upon first login.")
		}
	}

	var finopsCount int
	DB.QueryRow("SELECT COUNT(*) FROM finops_settings").Scan(&finopsCount)
	if finopsCount == 0 {
		_, err := DB.Exec(`INSERT INTO finops_settings (id, dev_hourly_rate, ci_minute_cost, avg_pipeline_duration, avg_investigation_time, currency) 
			VALUES (1, 50.0, 0.008, 15.0, 30.0, 'USD')`)
		if err != nil {
			log.Printf("[WARNING] Could not seed default FinOps settings: %v", err)
		} else {
			log.Println("[INFO] Default FinOps baseline metrics initialized.")
		}
	}
}

func GetProjectByAPIKey(apiKey string) (ProjectConfig, error) {
	var p ProjectConfig
	err := DB.QueryRow(`
		SELECT id, name, ci_system, api_key, slack_channel, jira_project_key, teams_webhook 
		FROM projects WHERE api_key = ?`, apiKey).Scan(
		&p.ID, &p.Name, &p.CISystem, &p.APIKey, &p.Routing.SlackChannel, &p.Routing.JiraProjectKey, &p.Routing.TeamsWebhook)
	return p, err
}
