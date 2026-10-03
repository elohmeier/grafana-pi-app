package chatlog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite" // Pure Go SQLite driver; the plugin builds without CGO.
)

const sqliteFileName = "chats.db"

// SQLitePath resolves the embedded database location: GF_PLUGIN_SQLITE_PATH
// (Grafana passes `[plugin.<id>] sqlite_path` this way), PI_SESSION_SQLITE_PATH,
// or <parent of the plugins directory>/plugin-data/<pluginID>/chats.db.
func SQLitePath(pluginID string) (string, error) {
	for _, name := range []string{"GF_PLUGIN_SQLITE_PATH", "PI_SESSION_SQLITE_PATH"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return filepath.Abs(value)
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	return defaultSQLitePath(executable, pluginID)
}

// The executable lives at <pluginsDir>/<pluginFolder>/gpx_*.
func defaultSQLitePath(executable, pluginID string) (string, error) {
	if pluginID == "" || strings.ContainsAny(pluginID, `/\`) || pluginID == "." || pluginID == ".." {
		return "", errors.New("invalid plugin ID for the chat database path")
	}
	pluginsDir := filepath.Dir(filepath.Dir(executable))
	return filepath.Join(filepath.Dir(pluginsDir), "plugin-data", pluginID, sqliteFileName), nil
}

type sharedSQLite struct {
	db      *sql.DB
	writeMu sync.Mutex
	refs    int
}

// Plugin instances (one per organization) run in one process and share one
// connection pool per database file.
var (
	sqliteMu  sync.Mutex
	sqliteDBs = map[string]*sharedSQLite{}
)

// OpenSQLite opens (creating if needed) the embedded chat database at path.
func OpenSQLite(ctx context.Context, path string) (Store, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if strings.ContainsAny(path, "?#") {
		return nil, fmt.Errorf("unsupported characters in chat database path %q", path)
	}
	sqliteMu.Lock()
	defer sqliteMu.Unlock()
	shared := sqliteDBs[path]
	if shared == nil {
		if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_txlock=immediate")
		if err != nil {
			return nil, err
		}
		// WAL allows concurrent readers; writes are serialized by writeMu and BEGIN IMMEDIATE.
		db.SetMaxOpenConns(4)
		shared = &sharedSQLite{db: db}
		s := shared.store(path)
		if err = s.write(ctx, func(tx *sql.Tx) error { return s.migrate(ctx, tx) }); err != nil {
			_ = db.Close()
			return nil, err
		}
		_ = os.Chmod(path, 0o600)
		sqliteDBs[path] = shared
	}
	shared.refs++
	return shared.store(path), nil
}

func (shared *sharedSQLite) store(path string) *sqlStore {
	return &sqlStore{
		db:      shared.db,
		d:       dialect{backend: "SQLite (" + path + ")"},
		writeMu: &shared.writeMu,
		close: func() error {
			sqliteMu.Lock()
			defer sqliteMu.Unlock()
			shared.refs--
			if shared.refs > 0 {
				return nil
			}
			delete(sqliteDBs, path)
			return shared.db.Close()
		},
	}
}
