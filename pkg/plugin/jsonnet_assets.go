package plugin

import (
	"embed"
	"fmt"
	"io/fs"
	"path"
	"strings"

	jsonnet "github.com/google/go-jsonnet"
)

//go:embed jsonnet/vendor
var jsonnetAssets embed.FS

const (
	jsonnetVendorRoot = "jsonnet/vendor"
)

type embeddedJsonnetImporter struct {
	files    fs.FS
	contents map[string]jsonnet.Contents
}

func (i *embeddedJsonnetImporter) Import(importedFrom, importedPath string) (jsonnet.Contents, string, error) {
	candidates := make([]string, 0, 2)
	if importedFrom != "" && !path.IsAbs(importedPath) {
		candidates = append(candidates, path.Clean(path.Join(path.Dir(importedFrom), importedPath)))
	}
	candidates = append(candidates, path.Clean(path.Join(jsonnetVendorRoot, importedPath)))

	for _, candidate := range candidates {
		if !isEmbeddedJsonnetPathAllowed(candidate) {
			continue
		}
		if contents, ok := i.contents[candidate]; ok {
			return contents, candidate, nil
		}
		content, err := fs.ReadFile(i.files, candidate)
		if err == nil {
			contents := jsonnet.MakeContentsRaw(content)
			i.contents[candidate] = contents
			return contents, candidate, nil
		}
	}

	return jsonnet.Contents{}, "", fmt.Errorf("jsonnet import not found: %s", importedPath)
}

func isEmbeddedJsonnetPathAllowed(candidate string) bool {
	if strings.Contains(candidate, "\x00") {
		return false
	}
	cleaned := path.Clean(candidate)
	if cleaned != candidate || strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return false
	}
	return strings.HasPrefix(cleaned, jsonnetVendorRoot+"/")
}
