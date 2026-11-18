package api

// SkillsResponse is the response of GET /skills: the custom skills in the
// skills directory of the Grafana server.
type SkillsResponse struct {
	// Configured is true when a skills directory is set.
	Configured bool         `json:"configured"`
	Skills     []Skill      `json:"skills"`
	Errors     []SkillError `json:"errors,omitempty"`
}

// Skill is one skill directory: SKILL.md and its text resources.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Content is SKILL.md as written, with its frontmatter.
	Content                string           `json:"content"`
	DisableModelInvocation bool             `json:"disableModelInvocation,omitempty"`
	Activation             *SkillActivation `json:"activation,omitempty"`
	Resources              []SkillResource  `json:"resources"`
}

type SkillActivation struct {
	Keywords     []string `json:"keywords,omitempty"`
	Regex        string   `json:"regex,omitempty"`
	ExplicitOnly *bool    `json:"explicitOnly,omitempty"`
}

type SkillResource struct {
	// Path is relative to the skill directory, for example references/runbook.md.
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SkillError names a skill directory or file that was skipped.
type SkillError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}
