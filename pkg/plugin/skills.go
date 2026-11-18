package plugin

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"sigs.k8s.io/yaml"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

// Custom skills can live in a directory of the Grafana server instead of the
// plugin's jsonData, which Grafana limits to 64 KiB. The directory holds one
// directory per skill, in the layout of the bundled skills:
//
//	<skills path>/<name>/SKILL.md
//	<skills path>/<name>/references/*.md (also templates/, assets/, scripts/)
//
// It is read on every request, so changes (such as an updated ConfigMap
// mount) apply to the next chat without a restart.
const (
	maxDirectorySkills    = 100
	maxSkillFileBytes     = 64 << 10
	maxSkillResources     = 100
	maxSkillResourceBytes = 256 << 10
	maxSkillsTotalBytes   = 8 << 20
	// Nesting below a resource directory; also stops symlink loops.
	maxSkillResourceDepth = 8
)

var (
	skillNamePattern        = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)
	skillResourceDirs       = []string{"assets", "references", "scripts", "templates"}
	skillResourceExtensions = map[string]bool{
		".css": true, ".csv": true, ".jq": true, ".json": true, ".jsonnet": true, ".libsonnet": true,
		".md": true, ".promql": true, ".py": true, ".sh": true, ".ts": true, ".tsx": true, ".txt": true,
		".yaml": true, ".yml": true,
	}
)

// skillsPath is the skills directory: skills_path in the [plugin.<plugin id>]
// section of grafana.ini, which Grafana passes as GF_PLUGIN_SKILLS_PATH, or
// PI_SKILLS_PATH in Grafana's environment.
func skillsPath() string {
	if value := strings.TrimSpace(os.Getenv("GF_PLUGIN_SKILLS_PATH")); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv("PI_SKILLS_PATH"))
}

func (a *App) handleSkills(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	root := skillsPath()
	if root == "" {
		writeJSON(w, http.StatusOK, api.SkillsResponse{Skills: []api.Skill{}})
		return
	}
	response := loadSkillsDirectory(root)
	for _, skillErr := range response.Errors {
		log.DefaultLogger.Warn("Skipped custom skill file", "path", skillErr.Path, "error", skillErr.Error)
	}
	writeJSON(w, http.StatusOK, response)
}

func loadSkillsDirectory(root string) api.SkillsResponse {
	response := api.SkillsResponse{Configured: true, Skills: []api.Skill{}}
	fail := func(name string, err error) {
		response.Errors = append(response.Errors, api.SkillError{Path: name, Error: err.Error()})
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		fail(".", err)
		return response
	}
	total := 0
	for _, entry := range entries {
		name := entry.Name()
		// Kubernetes ConfigMap mounts keep their data in ..data and timestamped dot directories.
		if strings.HasPrefix(name, ".") {
			continue
		}
		dir := filepath.Join(root, name)
		// Follows symlinks: ConfigMap mounts link every entry.
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			continue
		}
		if len(response.Skills) == maxDirectorySkills {
			fail(name, fmt.Errorf("more than %d skills; the rest are skipped", maxDirectorySkills))
			break
		}
		skill, size, errs := loadSkill(dir, name)
		for _, skillErr := range errs {
			fail(skillErr.Path, fmt.Errorf("%s", skillErr.Error))
		}
		if skill == nil {
			continue
		}
		if total+size > maxSkillsTotalBytes {
			fail(name, fmt.Errorf("the skills exceed %d bytes together; this and later skills are skipped", maxSkillsTotalBytes))
			break
		}
		total += size
		response.Skills = append(response.Skills, *skill)
	}
	return response
}

type skillFrontmatter struct {
	Name                   string               `json:"name"`
	Description            string               `json:"description"`
	DisableModelInvocation bool                 `json:"disable-model-invocation"`
	Activation             *api.SkillActivation `json:"activation"`
}

// loadSkill reads one skill directory. It returns nil when SKILL.md is
// missing or invalid; resources that cannot be read are skipped and reported.
func loadSkill(dir, dirName string) (*api.Skill, int, []api.SkillError) {
	skillFile := path.Join(dirName, "SKILL.md")
	source, err := readSkillText(filepath.Join(dir, "SKILL.md"), maxSkillFileBytes)
	if err != nil {
		return nil, 0, []api.SkillError{{Path: skillFile, Error: err.Error()}}
	}
	frontmatter, body, err := parseSkillFrontmatter(source)
	if err == nil {
		err = validateSkillFrontmatter(frontmatter, body, dirName)
	}
	if err != nil {
		return nil, 0, []api.SkillError{{Path: skillFile, Error: err.Error()}}
	}
	skill := &api.Skill{
		Name:                   frontmatter.Name,
		Description:            strings.TrimSpace(frontmatter.Description),
		Content:                strings.TrimRight(source, " \t\r\n"),
		DisableModelInvocation: frontmatter.DisableModelInvocation,
		Activation:             frontmatter.Activation,
		Resources:              []api.SkillResource{},
	}
	size := len(skill.Content)
	var errs []api.SkillError
	for _, resourceDir := range skillResourceDirs {
		walkSkillResources(dir, resourceDir, 0, func(relative string, err error) {
			if err == nil && len(skill.Resources) == maxSkillResources {
				err = fmt.Errorf("more than %d resources; the rest are skipped", maxSkillResources)
			}
			var content string
			if err == nil {
				content, err = readSkillText(filepath.Join(dir, filepath.FromSlash(relative)), maxSkillResourceBytes)
			}
			if err != nil {
				errs = append(errs, api.SkillError{Path: path.Join(dirName, relative), Error: err.Error()})
				return
			}
			content = strings.TrimRight(content, " \t\r\n")
			size += len(content)
			skill.Resources = append(skill.Resources, api.SkillResource{Path: relative, Content: content})
		})
	}
	return skill, size, errs
}

// walkSkillResources visits the text files below dir/relative in name order.
func walkSkillResources(dir, relative string, depth int, visit func(relative string, err error)) {
	entries, err := os.ReadDir(filepath.Join(dir, filepath.FromSlash(relative)))
	if err != nil {
		if depth > 0 || !os.IsNotExist(err) {
			visit(relative, err)
		}
		return
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		child := path.Join(relative, entry.Name())
		info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(child)))
		if err != nil {
			visit(child, err)
			continue
		}
		if info.IsDir() {
			if depth+1 >= maxSkillResourceDepth {
				visit(child, fmt.Errorf("nested more than %d directories deep", maxSkillResourceDepth))
				continue
			}
			walkSkillResources(dir, child, depth+1, visit)
			continue
		}
		if info.Mode().IsRegular() && skillResourceExtensions[strings.ToLower(path.Ext(child))] {
			visit(child, nil)
		}
	}
}

func readSkillText(file string, limit int64) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > limit {
		return "", fmt.Errorf("larger than %d bytes", limit)
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("not UTF-8 text")
	}
	return string(bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))), nil
}

func parseSkillFrontmatter(source string) (skillFrontmatter, string, error) {
	var frontmatter skillFrontmatter
	if !strings.HasPrefix(source, "---\n") {
		return frontmatter, "", fmt.Errorf("SKILL.md must start with YAML frontmatter (---)")
	}
	rest := source[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end == -1 {
		return frontmatter, "", fmt.Errorf("SKILL.md frontmatter must end with ---")
	}
	body := rest[end+len("\n---"):]
	if newline := strings.IndexByte(body, '\n'); newline >= 0 && strings.TrimSpace(body[:newline]) == "" {
		body = body[newline+1:]
	} else if strings.TrimSpace(body) != "" {
		return frontmatter, "", fmt.Errorf("SKILL.md frontmatter must end with a line of ---")
	}
	if err := yaml.Unmarshal([]byte(rest[:end]), &frontmatter); err != nil {
		return frontmatter, "", fmt.Errorf("invalid frontmatter: %w", err)
	}
	return frontmatter, strings.TrimSpace(body), nil
}

func validateSkillFrontmatter(frontmatter skillFrontmatter, body, dirName string) error {
	switch {
	case !skillNamePattern.MatchString(frontmatter.Name) || strings.Contains(frontmatter.Name, "--"):
		return fmt.Errorf("frontmatter name must be lowercase kebab-case and 2-64 characters")
	case frontmatter.Name != dirName:
		return fmt.Errorf("frontmatter name %q must match the directory name", frontmatter.Name)
	case strings.TrimSpace(frontmatter.Description) == "":
		return fmt.Errorf("frontmatter description is required")
	case len(frontmatter.Description) > 1024:
		return fmt.Errorf("frontmatter description must be 1024 characters or fewer")
	case body == "":
		return fmt.Errorf("SKILL.md body must not be empty")
	}
	return nil
}
