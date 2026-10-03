package api

// JsonnetEvalRequest is the body of POST /jsonnet/eval.
type JsonnetEvalRequest struct {
	Entrypoint string            `json:"entrypoint"`
	Files      map[string]string `json:"files"`
	ExtStr     map[string]string `json:"extStr,omitempty"`
	TLAStr     map[string]string `json:"tlaStr,omitempty"`
	// String evaluates to a raw string (jsonnet -S).
	String bool `json:"string,omitempty"`
}

// JsonnetEvalResponse is the response of POST /jsonnet/eval.
type JsonnetEvalResponse struct {
	Output string `json:"output"`
}

// JsonnetFixRequest is the body of POST /jsonnet/fix.
type JsonnetFixRequest struct {
	Source string `json:"source"`
}

// JsonnetFixResponse is the response of POST /jsonnet/fix.
type JsonnetFixResponse struct {
	Source  string   `json:"source"`
	Repairs []string `json:"repairs"`
}

// JsonnetLibFilesRequest is the body of POST /jsonnet-libs/files.
type JsonnetLibFilesRequest struct {
	// Package selects one package and returns its file contents. Without it,
	// the response lists every file without contents.
	Package string `json:"package,omitempty"`
}

// JsonnetLibFile is one vendored library file; Path is its import path.
type JsonnetLibFile struct {
	Path    string  `json:"path"`
	Size    int     `json:"size"`
	Content *string `json:"content,omitempty"`
}

// JsonnetLibFilesResponse is the response of POST /jsonnet-libs/files.
type JsonnetLibFilesResponse struct {
	Packages []string         `json:"packages"`
	Files    []JsonnetLibFile `json:"files"`
}
