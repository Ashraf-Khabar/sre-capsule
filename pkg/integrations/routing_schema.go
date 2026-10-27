package integrations

// RoutingField describes one project-level routing input for a CI/CD gateway.
type RoutingField struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Placeholder string `json:"placeholder"`
	InputType   string `json:"input_type"` // text, url, password, textarea
	Group       string `json:"group"`
	Hint        string `json:"hint,omitempty"`
}

// RoutingFieldsForIntegration returns the per-gateway slice of that plugin's own form.
func RoutingFieldsForIntegration(integration string) []RoutingField {
	var out []RoutingField
	for _, f := range ConfigFieldsForIntegration(integration) {
		if !f.Gateway || f.Group == "message" {
			continue
		}
		out = append(out, RoutingField{
			Key:         f.Key,
			Label:       f.Label,
			Placeholder: f.Placeholder,
			InputType:   f.InputType,
			Group:       f.Group,
			Hint:        f.Hint,
		})
	}
	return out
}
