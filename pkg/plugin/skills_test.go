package plugin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

func writeSkillFile(t *testing.T, root, name, content string) {
	t.Helper()
	file := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

const runbookSkill = `---
name: team-runbook
description: Use the team incident workflow.
license: internal
activation:
  keywords: [incident, outage]
  explicitOnly: false
---

# Team Runbook

Check service SLOs first.
`

func TestLoadSkillsDirectory(t *testing.T) {
	root := t.TempDir()
	writeSkillFile(t, root, "team-runbook/SKILL.md", runbookSkill)
	writeSkillFile(t, root, "team-runbook/references/escalation.md", "# Escalation\r\n\r\nAfter 15 minutes.\n\n")
	writeSkillFile(t, root, "team-runbook/references/deep/queries.promql", "up == 0\n")
	writeSkillFile(t, root, "team-runbook/references/diagram.png", "\x89PNG")
	writeSkillFile(t, root, "team-runbook/notes.md", "not a resource directory")
	writeSkillFile(t, root, "README.md", "not a skill")

	response := loadSkillsDirectory(root)

	if !response.Configured || len(response.Errors) != 0 {
		t.Fatalf("unexpected response: %+v", response)
	}
	if len(response.Skills) != 1 {
		t.Fatalf("expected one skill, got %d", len(response.Skills))
	}
	skill := response.Skills[0]
	if skill.Name != "team-runbook" || skill.Description != "Use the team incident workflow." {
		t.Fatalf("unexpected skill: %+v", skill)
	}
	if !strings.HasPrefix(skill.Content, "---\nname: team-runbook") || !strings.HasSuffix(skill.Content, "SLOs first.") {
		t.Fatalf("content should be SKILL.md as written: %q", skill.Content)
	}
	if skill.Activation == nil || strings.Join(skill.Activation.Keywords, ",") != "incident,outage" ||
		skill.Activation.ExplicitOnly == nil || *skill.Activation.ExplicitOnly {
		t.Fatalf("unexpected activation: %+v", skill.Activation)
	}
	want := []api.SkillResource{
		{Path: "references/deep/queries.promql", Content: "up == 0"},
		{Path: "references/escalation.md", Content: "# Escalation\n\nAfter 15 minutes."},
	}
	if len(skill.Resources) != len(want) {
		t.Fatalf("unexpected resources: %+v", skill.Resources)
	}
	for i := range want {
		if skill.Resources[i] != want[i] {
			t.Fatalf("resource %d: got %+v, want %+v", i, skill.Resources[i], want[i])
		}
	}
}

// A ConfigMap volume links every entry through ..data to a timestamped directory.
func TestLoadSkillsDirectoryFollowsConfigMapSymlinks(t *testing.T) {
	root := t.TempDir()
	writeSkillFile(t, root, "..2026_01_01_00_00_00.000000000/team-runbook/SKILL.md", runbookSkill)
	writeSkillFile(t, root, "..2026_01_01_00_00_00.000000000/team-runbook/references/escalation.md", "# Escalation\n")
	if err := os.Symlink("..2026_01_01_00_00_00.000000000", filepath.Join(root, "..data")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("..data/team-runbook", filepath.Join(root, "team-runbook")); err != nil {
		t.Fatal(err)
	}

	response := loadSkillsDirectory(root)

	if len(response.Errors) != 0 || len(response.Skills) != 1 || len(response.Skills[0].Resources) != 1 {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestLoadSkillsDirectoryReportsInvalidSkills(t *testing.T) {
	root := t.TempDir()
	writeSkillFile(t, root, "other-name/SKILL.md", runbookSkill)
	writeSkillFile(t, root, "no-frontmatter/SKILL.md", "# Title\n")
	writeSkillFile(t, root, "empty-body/SKILL.md", "---\nname: empty-body\ndescription: x\n---\n")
	writeSkillFile(t, root, "bad-yaml/SKILL.md", "---\nname: bad-yaml\ndescription: x\nactivation:\n  keywords: incident\n---\nBody\n")
	if err := os.MkdirAll(filepath.Join(root, "no-skill-file"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeSkillFile(t, root, "big-resource/SKILL.md", "---\nname: big-resource\ndescription: x\n---\nBody\n")
	writeSkillFile(t, root, "big-resource/references/large.md", strings.Repeat("x", maxSkillResourceBytes+1))
	writeSkillFile(t, root, "big-resource/references/binary.txt", "\xff\xfe")

	response := loadSkillsDirectory(root)

	if len(response.Skills) != 1 || response.Skills[0].Name != "big-resource" || len(response.Skills[0].Resources) != 0 {
		t.Fatalf("only big-resource should load, without resources: %+v", response.Skills)
	}
	errorsByPath := map[string]string{}
	for _, skillErr := range response.Errors {
		errorsByPath[skillErr.Path] = skillErr.Error
	}
	for file, message := range map[string]string{
		"other-name/SKILL.md":                "must match the directory name",
		"no-frontmatter/SKILL.md":            "must start with YAML frontmatter",
		"empty-body/SKILL.md":                "body must not be empty",
		"bad-yaml/SKILL.md":                  "invalid frontmatter",
		"no-skill-file/SKILL.md":             "no such file",
		"big-resource/references/large.md":   "larger than",
		"big-resource/references/binary.txt": "not UTF-8",
	} {
		if !strings.Contains(errorsByPath[file], message) {
			t.Errorf("%s: expected error containing %q, got %q", file, message, errorsByPath[file])
		}
	}
}

func TestLoadSkillsDirectoryMissingRoot(t *testing.T) {
	response := loadSkillsDirectory(filepath.Join(t.TempDir(), "missing"))
	if !response.Configured || len(response.Skills) != 0 || len(response.Errors) != 1 {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestHandleSkills(t *testing.T) {
	root := t.TempDir()
	writeSkillFile(t, root, "team-runbook/SKILL.md", runbookSkill)
	app := &App{}

	for _, tc := range []struct {
		env        map[string]string
		configured bool
		skills     int
	}{
		{env: map[string]string{}, configured: false, skills: 0},
		{env: map[string]string{"PI_SKILLS_PATH": root}, configured: true, skills: 1},
		{env: map[string]string{"GF_PLUGIN_SKILLS_PATH": root, "PI_SKILLS_PATH": t.TempDir()}, configured: true, skills: 1},
	} {
		t.Setenv("GF_PLUGIN_SKILLS_PATH", tc.env["GF_PLUGIN_SKILLS_PATH"])
		t.Setenv("PI_SKILLS_PATH", tc.env["PI_SKILLS_PATH"])
		recorder := httptest.NewRecorder()
		app.handleSkills(recorder, httptest.NewRequest(http.MethodGet, "/skills", nil))
		var response api.SkillsResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if recorder.Code != http.StatusOK || response.Configured != tc.configured || len(response.Skills) != tc.skills ||
			response.Skills == nil {
			t.Fatalf("env %v: unexpected response %d %+v", tc.env, recorder.Code, response)
		}
	}

	recorder := httptest.NewRecorder()
	app.handleSkills(recorder, httptest.NewRequest(http.MethodPost, "/skills", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: got %d", recorder.Code)
	}
}
