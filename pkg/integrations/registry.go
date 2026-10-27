package integrations

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Registry holds integrations loaded once at process start (immutable).
type Registry struct {
	mu       sync.RWMutex
	byID     map[string]*Manifest
	byPath   map[string]*Manifest
	order    []*Manifest
	dir      string
}

func LoadRegistry(pluginsDir string) (*Registry, error) {
	abs, err := filepath.Abs(pluginsDir)
	if err != nil {
		return nil, err
	}
	reg := &Registry{
		byID:   make(map[string]*Manifest),
		byPath: make(map[string]*Manifest),
		dir:    abs,
	}
	err = filepath.WalkDir(abs, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		var raw map[string]interface{}
		if json.Unmarshal(data, &raw) != nil {
			return nil
		}
		if _, hasCommand := raw["command"]; hasCommand {
			slog.Warn("legacy plugin manifest uses shell command; ignored for security",
				"path", path,
				"hint", "use \"integration\" field and native Go handlers",
			)
			delete(raw, "command")
		}
		rel, _ := filepath.Rel(abs, path)
		rel = filepath.ToSlash(rel)
		intType, err := inferIntegration(rel, raw)
		if err != nil {
			slog.Warn("skipping plugin manifest", "path", rel, "error", err)
			return nil
		}
		status := stringField(raw, "status", "")
		if status == "" {
			status = "Active"
		}
		autoRun := parseAutoRun(raw, status)
		routingEnabled := parseRoutingEnabled(raw, autoRun)
		m := &Manifest{
			ID:             strings.TrimSuffix(filepath.Base(rel), ".json"),
			FilePath:       rel,
			Integration:    intType,
			Name:           stringField(raw, "name", intType),
			Version:        stringField(raw, "version", "1.0"),
			Description:    stringField(raw, "description", ""),
			Status:         status,
			AutoRun:        autoRun,
			RoutingEnabled: routingEnabled,
			TriggerOn:      stringSliceField(raw, "trigger_on"),
			Config:         mergeConfig(raw),
		}
		reg.byID[m.ID] = m
		reg.byPath[rel] = m
		reg.order = append(reg.order, m)
		return nil
	})
	if err != nil {
		return nil, err
	}
	slog.Info("remediation registry loaded", "count", len(reg.order), "directory", abs)
	return reg, nil
}

func parseAutoRun(raw map[string]interface{}, status string) bool {
	if v, ok := raw["auto_run"].(bool); ok {
		return v
	}
	// Legacy: status Active implied auto-run unless explicitly set false
	return strings.EqualFold(status, "active")
}

func parseRoutingEnabled(raw map[string]interface{}, autoRun bool) bool {
	if v, ok := raw["routing_enabled"].(bool); ok {
		return v
	}
	// Legacy installs: auto_run integrations stay eligible for CI/CD gateway routing
	return autoRun
}

func stringField(m map[string]interface{}, key, def string) string {
	if v, ok := m[key].(string); ok && v != "" {
		return v
	}
	return def
}

func stringSliceField(m map[string]interface{}, key string) []string {
	raw, ok := m[key].([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func (r *Registry) List() []*Manifest {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Manifest, len(r.order))
	copy(out, r.order)
	return out
}

func (r *Registry) GetByPath(path string) (*Manifest, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.byPath[path]
	return m, ok
}

func (r *Registry) resolveManifestPath(filePath string) (string, error) {
	clean := filepath.ToSlash(filepath.Clean(strings.TrimSpace(filePath)))
	if clean == "" || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") {
		return "", fmt.Errorf("invalid integration path")
	}
	full := filepath.Join(r.dir, filepath.FromSlash(clean))
	absBase, err := filepath.Abs(r.dir)
	if err != nil {
		return "", err
	}
	absFull, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	if absFull != absBase && !strings.HasPrefix(absFull, absBase+string(filepath.Separator)) {
		return "", fmt.Errorf("integration path escapes plugins directory")
	}
	return absFull, nil
}

func (r *Registry) UpdateConfig(filePath string, cfg map[string]string, enableRouting bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.byPath[filePath]
	if !ok {
		return fmt.Errorf("integration not found: %s", filePath)
	}
	for k, v := range cfg {
		m.Config[k] = v
	}
	if enableRouting {
		m.RoutingEnabled = true
	}
	full, err := r.resolveManifestPath(filePath)
	if err != nil {
		return err
	}
	return writeManifestFile(full, m)
}

func (r *Registry) UpdateRoutingEnabled(filePath string, enabled bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.byPath[filePath]
	if !ok {
		return fmt.Errorf("integration not found: %s", filePath)
	}
	m.RoutingEnabled = enabled
	full, err := r.resolveManifestPath(filePath)
	if err != nil {
		return err
	}
	return writeManifestFile(full, m)
}

func (r *Registry) UpdateAutoRun(filePath string, autoRun bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.byPath[filePath]
	if !ok {
		return fmt.Errorf("integration not found: %s", filePath)
	}
	m.AutoRun = autoRun
	if autoRun {
		m.RoutingEnabled = true
		if !strings.EqualFold(m.Status, "active") {
			m.Status = "Active"
		}
	}
	full, err := r.resolveManifestPath(filePath)
	if err != nil {
		return err
	}
	return writeManifestFile(full, m)
}

func writeManifestFile(full string, m *Manifest) error {
	raw := map[string]interface{}{
		"integration":     m.Integration,
		"name":            m.Name,
		"version":         m.Version,
		"description":     m.Description,
		"status":          m.Status,
		"auto_run":        m.AutoRun,
		"routing_enabled": m.RoutingEnabled,
		"trigger_on":      m.TriggerOn,
		"config":          m.Config,
	}
	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(full, data, 0o600)
}

// IsActiveForRouting is true when the integration is enabled for CI/CD gateway routing.
func IsActiveForRouting(status string, routingEnabled, autoRun bool) bool {
	if !strings.EqualFold(strings.TrimSpace(status), "active") {
		return false
	}
	return routingEnabled || autoRun
}

// ToAPIList returns manifests for the Plugin Engine UI (no command field).
func (r *Registry) ToAPIList() []map[string]interface{} {
	list := r.List()
	out := make([]map[string]interface{}, 0, len(list))
	for _, m := range list {
		out = append(out, map[string]interface{}{
			"id":             m.ID,
			"file_path":      m.FilePath,
			"integration":    m.Integration,
			"name":           m.Name,
			"version":        m.Version,
			"description":    m.Description,
			"status":           m.Status,
			"auto_run":         m.AutoRun,
			"routing_enabled":  m.RoutingEnabled,
			"trigger_on":       m.TriggerOn,
			"routing_fields": RoutingFieldsForIntegration(m.Integration),
			"config_fields":  ConfigFieldsForIntegration(m.Integration),
			"env":            m.Config,
			"config":         m.Config,
		})
	}
	return out
}
