package plugin

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"sort"
	"strings"
)

// Vendored library packages exposed to the assistant. The session filesystem
// mounts them read-only at /lib/jsonnet/<package>/..., mirroring import paths.
var jsonnetLibPackages = []string{
	"github.com/g42/pi-dashboard",
	"github.com/grafana/grafonnet",
	"github.com/jsonnet-libs/docsonnet",
	"github.com/jsonnet-libs/xtd",
}

type jsonnetLibFilesRequest struct {
	// Package selects one entry of jsonnetLibPackages and returns its file
	// contents. Without it, the response lists every file without contents.
	Package string `json:"package,omitempty"`
}

type jsonnetLibFile struct {
	Path    string  `json:"path"`
	Size    int     `json:"size"`
	Content *string `json:"content,omitempty"`
}

func (a *App) handleJsonnetLibFiles(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body jsonnetLibFilesRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 4<<10)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	files, err := jsonnetLibFiles(body.Package)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"packages": jsonnetLibPackages, "files": files})
}

// jsonnetLibFiles lists the files of all packages, or returns the files of one
// package with their contents. Paths are import paths relative to the vendor root.
func jsonnetLibFiles(pkg string) ([]jsonnetLibFile, error) {
	packages := jsonnetLibPackages
	withContent := pkg != ""
	if withContent {
		known := false
		for _, candidate := range jsonnetLibPackages {
			known = known || candidate == pkg
		}
		if !known {
			return nil, fmt.Errorf("unknown package %q; available: %s", pkg, strings.Join(jsonnetLibPackages, ", "))
		}
		packages = []string{pkg}
	}
	files := []jsonnetLibFile{}
	for _, name := range packages {
		root := jsonnetVendorRoot + "/" + name
		err := fs.WalkDir(jsonnetAssets, root, func(filePath string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			content, err := fs.ReadFile(jsonnetAssets, filePath)
			if err != nil {
				return err
			}
			file := jsonnetLibFile{Path: strings.TrimPrefix(filePath, jsonnetVendorRoot+"/"), Size: len(content)}
			if withContent {
				text := string(content)
				file.Content = &text
			}
			files = append(files, file)
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", name, err)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}
