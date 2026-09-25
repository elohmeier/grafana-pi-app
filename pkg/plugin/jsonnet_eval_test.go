package plugin

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestEvaluateWorkspaceJsonnetResolvesWorkspaceAndVendorImports(t *testing.T) {
	output, err := evaluateWorkspaceJsonnet(context.Background(), jsonnetEvalRequest{
		Entrypoint: "/workspace/main.jsonnet",
		Files: map[string]string{
			"/workspace/main.jsonnet":         `local lib = import 'lib/panels.libsonnet'; local d = import 'github.com/g42/pi-dashboard/main.libsonnet'; { title: std.extVar('title'), n: lib.n, hasHelper: std.objectHas(d, 'dashboard') }`,
			"/workspace/lib/panels.libsonnet": `{ n: 3 }`,
		},
		ExtStr: map[string]string{"title": "Checkout"},
	})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(output), &decoded); err != nil {
		t.Fatalf("decode %q: %v", output, err)
	}
	if decoded["title"] != "Checkout" || decoded["n"] != float64(3) || decoded["hasHelper"] != true {
		t.Fatalf("unexpected output: %v", decoded)
	}
}

func TestEvaluateWorkspaceJsonnetRejectsUnsafeInput(t *testing.T) {
	cases := []jsonnetEvalRequest{
		{Entrypoint: "/workspace/a.jsonnet", Files: map[string]string{"relative.jsonnet": "{}"}},
		{Entrypoint: "/workspace/a.jsonnet", Files: map[string]string{"/workspace/../a.jsonnet": "{}"}},
		{Entrypoint: "/workspace/missing.jsonnet", Files: map[string]string{"/workspace/a.jsonnet": "{}"}},
		{Entrypoint: "/workspace/a.jsonnet", Files: map[string]string{"/workspace/a.jsonnet": "import '/etc/passwd'"}},
		{Entrypoint: "/workspace/a.jsonnet", Files: map[string]string{"/workspace/a.jsonnet": "import '../../pkg/plugin/app.go'"}},
	}
	for index, request := range cases {
		if _, err := evaluateWorkspaceJsonnet(context.Background(), request); err == nil {
			t.Fatalf("case %d: expected an error", index)
		}
	}
}

func TestEvaluateWorkspaceJsonnetStringOutput(t *testing.T) {
	output, err := evaluateWorkspaceJsonnet(context.Background(), jsonnetEvalRequest{
		Entrypoint: "/tmp/a.jsonnet",
		Files:      map[string]string{"/tmp/a.jsonnet": `"hello " + std.extVar('who')`},
		ExtStr:     map[string]string{"who": "world"},
		String:     true,
	})
	if err != nil || strings.TrimSpace(output) != "hello world" {
		t.Fatalf("unexpected output %q err %v", output, err)
	}
}
