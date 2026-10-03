package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	jsonnet "github.com/google/go-jsonnet"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

// Stateless Jsonnet evaluation for the session workspace `jsonnet` shell
// command. The caller sends the workspace files the program may import; the
// embedded vendor tree is available as the library path. Nothing is stored.

const (
	jsonnetEvalMaxFiles       = 200
	jsonnetEvalMaxInputBytes  = 4 << 20
	jsonnetEvalMaxOutputBytes = 4 << 20
	jsonnetEvalTimeout        = 20 * time.Second
	jsonnetEvalMaxStack       = 500
)

// workspaceJsonnetImporter resolves relative imports against the provided
// workspace files first, then the embedded vendor tree.
type workspaceJsonnetImporter struct {
	files  map[string]string
	vendor *embeddedJsonnetImporter
}

func (i *workspaceJsonnetImporter) Import(importedFrom, importedPath string) (jsonnet.Contents, string, error) {
	if strings.HasPrefix(importedFrom, "/") || importedFrom == "" {
		var candidate string
		if path.IsAbs(importedPath) {
			candidate = path.Clean(importedPath)
		} else if importedFrom != "" {
			candidate = path.Clean(path.Join(path.Dir(importedFrom), importedPath))
		}
		if candidate != "" {
			if content, ok := i.files[candidate]; ok {
				return jsonnet.MakeContents(content), candidate, nil
			}
		}
		// Library imports from workspace files resolve against the vendor root.
		return i.vendor.Import("", importedPath)
	}
	return i.vendor.Import(importedFrom, importedPath)
}

func (a *App) handleJsonnetEval(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body api.JsonnetEvalRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, jsonnetEvalMaxInputBytes+64<<10)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	output, err := evaluateWorkspaceJsonnet(req.Context(), body)
	if err != nil {
		writeJSONError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.JsonnetEvalResponse{Output: output})
}

func (a *App) handleJsonnetFix(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body api.JsonnetFixRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, jsonnetEvalMaxInputBytes)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	source, repairs, err := repairJsonnetDashboardSource(body.Source)
	if err != nil {
		writeJSONError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if repairs == nil {
		repairs = []string{}
	}
	writeJSON(w, http.StatusOK, api.JsonnetFixResponse{Source: source, Repairs: repairs})
}

func evaluateWorkspaceJsonnet(ctx context.Context, request api.JsonnetEvalRequest) (string, error) {
	if len(request.Files) > jsonnetEvalMaxFiles {
		return "", fmt.Errorf("too many files (%d > %d)", len(request.Files), jsonnetEvalMaxFiles)
	}
	files := make(map[string]string, len(request.Files))
	total := 0
	for name, content := range request.Files {
		cleaned := path.Clean(name)
		if !path.IsAbs(name) || cleaned != name || strings.Contains(name, "\x00") {
			return "", fmt.Errorf("invalid file path %q", name)
		}
		total += len(content)
		files[cleaned] = content
	}
	if total > jsonnetEvalMaxInputBytes {
		return "", fmt.Errorf("input too large (%d bytes)", total)
	}
	if _, ok := files[request.Entrypoint]; !ok {
		return "", fmt.Errorf("entrypoint %q not provided", request.Entrypoint)
	}

	vm := jsonnet.MakeVM()
	vm.MaxStack = jsonnetEvalMaxStack
	vm.Importer(&workspaceJsonnetImporter{
		files:  files,
		vendor: &embeddedJsonnetImporter{files: jsonnetAssets, contents: map[string]jsonnet.Contents{}},
	})
	vm.StringOutput = request.String
	for _, key := range sortedKeys(request.ExtStr) {
		vm.ExtVar(key, request.ExtStr[key])
	}
	for _, key := range sortedKeys(request.TLAStr) {
		vm.TLAVar(key, request.TLAStr[key])
	}

	type result struct {
		output string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		output, err := vm.EvaluateFile(request.Entrypoint)
		done <- result{output, err}
	}()
	ctx, cancel := context.WithTimeout(ctx, jsonnetEvalTimeout)
	defer cancel()
	select {
	case <-ctx.Done():
		// go-jsonnet cannot be interrupted; the goroutine finishes on its own.
		return "", fmt.Errorf("evaluation timed out after %s", jsonnetEvalTimeout)
	case evaluated := <-done:
		if evaluated.err != nil {
			return "", evaluated.err
		}
		if len(evaluated.output) > jsonnetEvalMaxOutputBytes {
			return "", fmt.Errorf("output too large (%d bytes)", len(evaluated.output))
		}
		return evaluated.output, nil
	}
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
