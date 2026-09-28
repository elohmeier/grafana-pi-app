// Package sessionstore owns assistant data independently of Grafana's schema.
package sessionstore

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrConflict = errors.New("session changed in another tab; reload it before saving")
	ErrNotFound = errors.New("session not found")
	ErrInvalid  = errors.New("invalid session request")
	identifier  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)
)

type Store struct {
	pool   *pgxpool.Pool
	schema string
}
type Metadata struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Revision  int64     `json:"revision"`
}
type Page struct {
	Items      []Metadata `json:"items"`
	NextCursor string     `json:"nextCursor,omitempty"`
}
type Session struct {
	Metadata
	Snapshot json.RawMessage `json:"snapshot"`
}
type Write struct {
	RequestID string          `json:"requestId"`
	Revision  int64           `json:"revision"`
	Title     string          `json:"title"`
	Snapshot  json.RawMessage `json:"snapshot"`
	// Import only creates missing sessions and preserves their original dates.
	Import    bool      `json:"import,omitempty"`
	CreatedAt time.Time `json:"createdAt,omitempty"`
	UpdatedAt time.Time `json:"updatedAt,omitempty"`
}

func Open(ctx context.Context, dsn, schema string) (*Store, error) {
	if !identifier.MatchString(schema) || schema == "public" || schema == "information_schema" || len(schema) >= 3 && schema[:3] == "pg_" {
		return nil, fmt.Errorf("invalid dedicated session schema")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid session PostgreSQL connection configuration")
	}
	cfg.MaxConns = 4
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams["application_name"] = "grafana-pi-sessions"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = "10000"
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	s := &Store{pool: p, schema: pgx.Identifier{schema}.Sanitize()}
	if err = s.migrate(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close()                         { s.pool.Close() }
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }
func lockKey(value string) int64 {
	sum := sha256.Sum256([]byte(value))
	return int64(binary.BigEndian.Uint64(sum[:8]))
}

func (s *Store) migrate(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }() // A committed transaction is already closed.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockKey("grafana-pi:migrations:"+s.schema)); err != nil {
		return err
	}
	// A pre-provisioned schema needs no database-wide CREATE privilege.
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)", s.schema[1:len(s.schema)-1]).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		if _, err = tx.Exec(ctx, "CREATE SCHEMA "+s.schema); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS `+s.schema+`.migrations (version integer PRIMARY KEY);
	CREATE TABLE IF NOT EXISTS `+s.schema+`.sessions (
	 scope text NOT NULL, id text NOT NULL, title text NOT NULL, created_at timestamptz NOT NULL,
	 updated_at timestamptz NOT NULL, revision bigint NOT NULL, deleted boolean NOT NULL DEFAULT false,
	 PRIMARY KEY(scope,id));
	CREATE INDEX IF NOT EXISTS sessions_recent ON `+s.schema+`.sessions (scope,updated_at DESC,id DESC) WHERE NOT deleted;
	CREATE TABLE IF NOT EXISTS `+s.schema+`.snapshots (
	 scope text NOT NULL,id text NOT NULL,payload jsonb NOT NULL,
	 PRIMARY KEY(scope,id),FOREIGN KEY(scope,id) REFERENCES `+s.schema+`.sessions(scope,id));
	CREATE TABLE IF NOT EXISTS `+s.schema+`.receipts (
	 scope text NOT NULL,request_id text NOT NULL,digest bytea NOT NULL,result jsonb NOT NULL,
	 PRIMARY KEY(scope,request_id));
	CREATE TABLE IF NOT EXISTS `+s.schema+`.legacy_imports (scope text PRIMARY KEY);
	INSERT INTO `+s.schema+`.migrations(version) VALUES(1) ON CONFLICT DO NOTHING;`)
	if err != nil {
		return err
	}
	var version int
	if err = tx.QueryRow(ctx, "SELECT max(version) FROM "+s.schema+".migrations").Scan(&version); err != nil {
		return err
	}
	if version != 1 {
		return fmt.Errorf("unsupported session schema version %d", version)
	}
	return tx.Commit(ctx)
}

type cursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func (s *Store) List(ctx context.Context, scope, after string, limit int) (Page, error) {
	page := Page{Items: []Metadata{}}
	if limit < 1 || limit > 100 {
		return page, ErrInvalid
	}
	c := cursor{At: time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), ID: ""}
	if after != "" {
		raw, err := base64.RawURLEncoding.DecodeString(after)
		if err != nil || json.Unmarshal(raw, &c) != nil || c.At.IsZero() || c.ID == "" {
			return page, ErrInvalid
		}
	}
	rows, err := s.pool.Query(ctx, "SELECT id,title,created_at,updated_at,revision FROM "+s.schema+".sessions WHERE scope=$1 AND NOT deleted AND (updated_at,id)<($2,$3) ORDER BY updated_at DESC,id DESC LIMIT $4", scope, c.At, c.ID, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var m Metadata
		if err = rows.Scan(&m.ID, &m.Title, &m.CreatedAt, &m.UpdatedAt, &m.Revision); err != nil {
			return page, err
		}
		page.Items = append(page.Items, m)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		raw, _ := json.Marshal(cursor{last.UpdatedAt, last.ID})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	return page, nil
}
func (s *Store) Get(ctx context.Context, scope, id string) (Session, error) {
	var result Session
	err := s.pool.QueryRow(ctx, "SELECT s.id,s.title,s.created_at,s.updated_at,s.revision,b.payload FROM "+s.schema+".sessions s JOIN "+s.schema+".snapshots b USING(scope,id) WHERE s.scope=$1 AND s.id=$2 AND NOT s.deleted", scope, id).Scan(&result.ID, &result.Title, &result.CreatedAt, &result.UpdatedAt, &result.Revision, &result.Snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return result, err
}

// Mutate commits metadata, body and a retry receipt atomically. Tombstones prevent
// a stale browser from recreating a deleted session with revision zero.
func (s *Store) Mutate(ctx context.Context, scope, id string, w Write, remove bool) (Metadata, error) {
	var result Metadata
	if id == "" || len(id) > 128 || len(w.RequestID) < 8 || len(w.RequestID) > 128 || w.Revision < 0 || len(w.Title) > 1024 || remove && w.Import {
		return result, ErrInvalid
	}
	if !remove {
		var payload struct {
			Messages []json.RawMessage `json:"messages"`
		}
		if len(w.Snapshot) > 32<<20 || json.Unmarshal(w.Snapshot, &payload) != nil || payload.Messages == nil {
			return result, ErrInvalid
		}
	}
	data, _ := json.Marshal(struct {
		ID     string
		Write  Write
		Remove bool
	}{id, w, remove})
	digest := sha256.Sum256(data)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }() // A committed transaction is already closed.
	// Lock scope first: serializes receipt IDs as well as creates across replicas.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockKey("grafana-pi:write:"+s.schema+":"+scope)); err != nil {
		return result, err
	}
	var oldDigest, receipt []byte
	err = tx.QueryRow(ctx, "SELECT digest,result FROM "+s.schema+".receipts WHERE scope=$1 AND request_id=$2", scope, w.RequestID).Scan(&oldDigest, &receipt)
	if err == nil {
		if string(oldDigest) != string(digest[:]) {
			return result, ErrConflict
		}
		err = json.Unmarshal(receipt, &result)
		return result, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	var deleted bool
	err = tx.QueryRow(ctx, "SELECT id,title,created_at,updated_at,revision,deleted FROM "+s.schema+".sessions WHERE scope=$1 AND id=$2", scope, id).Scan(&result.ID, &result.Title, &result.CreatedAt, &result.UpdatedAt, &result.Revision, &deleted)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if w.Import && exists { // Never overwrite newer data during a resumable legacy import.
		return result, nil
	}
	if deleted || exists && result.Revision != w.Revision || !exists && w.Revision != 0 {
		return result, ErrConflict
	}
	if remove && !exists {
		return result, ErrNotFound
	}
	// Use the shared database clock, independent of replica clock skew.
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return result, err
	}
	if !exists {
		result = Metadata{ID: id, CreatedAt: now}
	}
	result.Title = w.Title
	result.UpdatedAt = now
	result.Revision++
	if w.Import && !exists && !w.CreatedAt.IsZero() && !w.UpdatedAt.IsZero() {
		result.CreatedAt = w.CreatedAt
		result.UpdatedAt = w.UpdatedAt
	}
	if remove {
		result.Title = ""
	}
	_, err = tx.Exec(ctx, "INSERT INTO "+s.schema+".sessions(scope,id,title,created_at,updated_at,revision,deleted) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(scope,id) DO UPDATE SET title=EXCLUDED.title,updated_at=EXCLUDED.updated_at,revision=EXCLUDED.revision,deleted=EXCLUDED.deleted", scope, id, result.Title, result.CreatedAt, result.UpdatedAt, result.Revision, remove)
	if err != nil {
		return result, err
	}
	if remove {
		_, err = tx.Exec(ctx, "DELETE FROM "+s.schema+".snapshots WHERE scope=$1 AND id=$2", scope, id)
	} else {
		_, err = tx.Exec(ctx, "INSERT INTO "+s.schema+".snapshots(scope,id,payload) VALUES($1,$2,$3) ON CONFLICT(scope,id) DO UPDATE SET payload=EXCLUDED.payload", scope, id, w.Snapshot)
	}
	if err != nil {
		return result, err
	}
	receipt, _ = json.Marshal(result)
	if _, err = tx.Exec(ctx, "INSERT INTO "+s.schema+".receipts(scope,request_id,digest,result) VALUES($1,$2,$3,$4)", scope, w.RequestID, digest[:], receipt); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
func (s *Store) ImportComplete(ctx context.Context, scope string) (bool, error) {
	var complete bool
	err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM "+s.schema+".legacy_imports WHERE scope=$1)", scope).Scan(&complete)
	return complete, err
}
func (s *Store) CompleteImport(ctx context.Context, scope string) error {
	_, err := s.pool.Exec(ctx, "INSERT INTO "+s.schema+".legacy_imports(scope) VALUES($1) ON CONFLICT DO NOTHING", scope)
	return err
}
