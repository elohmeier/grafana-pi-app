// Package chatlog stores assistant chats as append-only commit logs.
//
// Each chat is written by a single durable harness in the browser. The writer
// owns a lease (epoch) obtained by opening the chat and appends commit batches
// with strictly increasing sequence numbers. Opening a chat replays its log.
// The same SQL runs on PostgreSQL (shared, HA deployments) and on an embedded
// SQLite database (single Grafana instance).
package chatlog

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

var (
	ErrInvalid  = errors.New("invalid chat request")
	ErrNotFound = errors.New("chat not found")
	ErrDeleted  = errors.New("chat was deleted")
	// ErrConflict matches every *ConflictError.
	ErrConflict = errors.New("chat commit conflict")

	chatID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

const (
	// ReasonLease means another writer opened the chat after this one.
	ReasonLease = "lease"
	// ReasonSequence means the commit sequence is not newer than the stored one.
	ReasonSequence = "sequence"

	MaxTitleRunes   = 200
	DefaultPageSize = 30
	MaxPageSize     = 100
	DefaultLogLimit = 5000
	MaxLogLimit     = 20000
	maxDigestBytes  = 512
	maxKeyBytes     = 1024
	insertChunkRows = 200
)

// ConflictError reports a rejected commit and why.
type ConflictError struct{ Reason string }

func (e *ConflictError) Error() string {
	if e.Reason == ReasonLease {
		return "chat was opened by another writer"
	}
	return "chat commit sequence is not newer than the stored log"
}
func (e *ConflictError) Is(target error) bool { return target == ErrConflict }

// The wire types live in pkg/api, from which the frontend's types are generated.
type (
	Chat         = api.Chat
	OpenedChat   = api.OpenedChat
	Page         = api.ChatPage
	Row          = api.ChatLogRow
	LogPage      = api.ChatLogPage
	CommitRow    = api.ChatCommitRow
	Commit       = api.ChatCommit
	CommitResult = api.ChatCommitResult
)

// Store is the chat log storage contract shared by both backends.
type Store interface {
	List(ctx context.Context, scope, cursor string, limit int) (Page, error)
	// Open makes the caller the chat's only writer; with create, a missing chat is created.
	Open(ctx context.Context, scope, id, title string, create bool) (OpenedChat, error)
	Log(ctx context.Context, scope, id, cursor string, limit int) (LogPage, error)
	Commit(ctx context.Context, scope, id string, c Commit) (CommitResult, error)
	Rename(ctx context.Context, scope, id, title string) (Chat, error)
	Delete(ctx context.Context, scope, id string) error
	Ping(ctx context.Context) error
	// Backend describes the storage for health checks, e.g. "PostgreSQL".
	Backend() string
	Close() error
}

// ValidID reports whether id is an acceptable chat ID.
func ValidID(id string) bool { return chatID.MatchString(id) }

// NormalizeTitle trims a title and shortens it to MaxTitleRunes.
func NormalizeTitle(title string) string {
	title = strings.TrimSpace(title)
	if utf8.RuneCountInString(title) > MaxTitleRunes {
		title = strings.TrimSpace(string([]rune(title)[:MaxTitleRunes]))
	}
	return title
}

type dialect struct {
	postgres bool
	prefix   string // schema qualifier including the dot, or empty
	backend  string
}

func (d dialect) t(name string) string { return d.prefix + name }

// q rewrites ? placeholders into PostgreSQL's $n form. No query contains a
// literal question mark.
func (d dialect) q(query string) string {
	if !d.postgres {
		return query
	}
	var b strings.Builder
	n := 0
	for _, r := range query {
		if r == '?' {
			n++
			b.WriteString("$" + strconv.Itoa(n))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
func (d dialect) forUpdate() string {
	if d.postgres {
		return " FOR UPDATE"
	}
	return ""
}
func (d dialect) byteLength(column string) string {
	if d.postgres {
		return "octet_length(" + column + ")"
	}
	return "length(CAST(" + column + " AS BLOB))"
}

type sqlStore struct {
	db *sql.DB
	d  dialect
	// writeMu serializes SQLite write transactions in this process; nil on PostgreSQL.
	writeMu *sync.Mutex
	close   func() error
	once    sync.Once
	err     error
}

func (s *sqlStore) Backend() string                { return s.d.backend }
func (s *sqlStore) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }
func (s *sqlStore) Close() error {
	s.once.Do(func() { s.err = s.close() })
	return s.err
}

func (s *sqlStore) exec(ctx context.Context, tx *sql.Tx, query string, args ...any) (sql.Result, error) {
	return tx.ExecContext(ctx, s.d.q(query), args...)
}

// write runs fn in a write transaction. On PostgreSQL, fn locks the chat row
// with SELECT ... FOR UPDATE; on SQLite the transaction is BEGIN IMMEDIATE and
// additionally serialized in-process.
func (s *sqlStore) write(ctx context.Context, fn func(tx *sql.Tx) error) error {
	if s.writeMu != nil {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }() // A committed transaction is already closed.
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// now returns the current time in microseconds. PostgreSQL uses the shared
// database clock so replicas with clock skew agree.
func (s *sqlStore) now(ctx context.Context, tx *sql.Tx) (int64, error) {
	if !s.d.postgres {
		return time.Now().UnixMicro(), nil
	}
	var now int64
	err := tx.QueryRowContext(ctx, "SELECT (extract(epoch FROM clock_timestamp())*1000000)::bigint").Scan(&now)
	return now, err
}

func micros(v int64) time.Time { return time.UnixMicro(v).UTC() }

func (s *sqlStore) migrate(ctx context.Context, tx *sql.Tx) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS ` + s.d.t("chatlog_migrations") + ` (version integer PRIMARY KEY)`,
		// Timestamps are Unix microseconds.
		`CREATE TABLE IF NOT EXISTS ` + s.d.t("chats") + ` (
		 scope text NOT NULL, id text NOT NULL, title text NOT NULL DEFAULT '',
		 created_at bigint NOT NULL, updated_at bigint NOT NULL,
		 epoch bigint NOT NULL DEFAULT 0, last_seq bigint NOT NULL DEFAULT 0,
		 last_digest text NOT NULL DEFAULT '', bytes bigint NOT NULL DEFAULT 0,
		 deleted boolean NOT NULL DEFAULT false,
		 PRIMARY KEY (scope, id))`,
		`CREATE INDEX IF NOT EXISTS chats_recent ON ` + s.d.t("chats") + ` (scope, updated_at DESC, id DESC) WHERE NOT deleted`,
		`CREATE TABLE IF NOT EXISTS ` + s.d.t("chat_rows") + ` (
		 scope text NOT NULL, chat_id text NOT NULL, seq bigint NOT NULL, idx integer NOT NULL,
		 key text, body text NOT NULL,
		 PRIMARY KEY (scope, chat_id, seq, idx))`,
		`CREATE INDEX IF NOT EXISTS chat_rows_key ON ` + s.d.t("chat_rows") + ` (scope, chat_id, key, seq) WHERE key IS NOT NULL`,
		`INSERT INTO ` + s.d.t("chatlog_migrations") + ` (version) VALUES (1) ON CONFLICT DO NOTHING`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	var version int
	if err := tx.QueryRowContext(ctx, "SELECT max(version) FROM "+s.d.t("chatlog_migrations")).Scan(&version); err != nil {
		return err
	}
	if version != 1 {
		return fmt.Errorf("unsupported chat schema version %d", version)
	}
	return nil
}

type listCursor struct {
	At int64  `json:"t"`
	ID string `json:"i"`
}
type logCursor struct {
	Seq int64 `json:"s"`
	Idx int   `json:"i"`
}

func encodeCursor(v any) string {
	raw, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(raw)
}
func decodeCursor(text string, v any) error {
	raw, err := base64.RawURLEncoding.DecodeString(text)
	if err != nil || json.Unmarshal(raw, v) != nil {
		return ErrInvalid
	}
	return nil
}

func (s *sqlStore) List(ctx context.Context, scope, cursor string, limit int) (Page, error) {
	page := Page{Items: []Chat{}}
	if scope == "" || limit < 1 || limit > MaxPageSize {
		return page, ErrInvalid
	}
	c := listCursor{At: math.MaxInt64}
	if cursor != "" {
		if err := decodeCursor(cursor, &c); err != nil || c.ID == "" {
			return page, ErrInvalid
		}
	}
	rows, err := s.db.QueryContext(ctx, s.d.q("SELECT id, title, created_at, updated_at FROM "+s.d.t("chats")+
		" WHERE scope = ? AND NOT deleted AND (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC LIMIT ?"),
		scope, c.At, c.ID, limit+1)
	if err != nil {
		return page, err
	}
	defer func() { _ = rows.Close() }()
	var last listCursor
	for rows.Next() {
		var chat Chat
		var created, updated int64
		if err = rows.Scan(&chat.ID, &chat.Title, &created, &updated); err != nil {
			return page, err
		}
		if len(page.Items) == limit {
			page.NextCursor = encodeCursor(last)
			break
		}
		chat.CreatedAt, chat.UpdatedAt = micros(created), micros(updated)
		page.Items = append(page.Items, chat)
		last = listCursor{At: updated, ID: chat.ID}
	}
	return page, rows.Err()
}

type chatState struct {
	title            string
	created, updated int64
	epoch, lastSeq   int64
	lastDigest       string
	deleted          bool
}

func (s *sqlStore) lockChat(ctx context.Context, tx *sql.Tx, scope, id string) (chatState, error) {
	var c chatState
	err := tx.QueryRowContext(ctx, s.d.q("SELECT title, created_at, updated_at, epoch, last_seq, last_digest, deleted FROM "+s.d.t("chats")+
		" WHERE scope = ? AND id = ?"+s.d.forUpdate()), scope, id).
		Scan(&c.title, &c.created, &c.updated, &c.epoch, &c.lastSeq, &c.lastDigest, &c.deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	if err == nil && c.deleted {
		return c, ErrDeleted
	}
	return c, err
}

func (s *sqlStore) Open(ctx context.Context, scope, id, title string, create bool) (OpenedChat, error) {
	var result OpenedChat
	if scope == "" || !ValidID(id) {
		return result, ErrInvalid
	}
	title = NormalizeTitle(title)
	err := s.write(ctx, func(tx *sql.Tx) error {
		now, err := s.now(ctx, tx)
		if err != nil {
			return err
		}
		if create {
			if _, err = s.exec(ctx, tx, "INSERT INTO "+s.d.t("chats")+" (scope, id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, id) DO NOTHING",
				scope, id, title, now, now); err != nil {
				return err
			}
		}
		c, err := s.lockChat(ctx, tx, scope, id)
		if err != nil {
			return err
		}
		c.epoch++
		if _, err = s.exec(ctx, tx, "UPDATE "+s.d.t("chats")+" SET epoch = ? WHERE scope = ? AND id = ?", c.epoch, scope, id); err != nil {
			return err
		}
		result = OpenedChat{Chat: Chat{ID: id, Title: c.title, CreatedAt: micros(c.created), UpdatedAt: micros(c.updated)}, Epoch: c.epoch, LastSeq: c.lastSeq}
		return nil
	})
	return result, err
}

func (s *sqlStore) Log(ctx context.Context, scope, id, cursor string, limit int) (LogPage, error) {
	page := LogPage{Rows: []Row{}}
	if scope == "" || !ValidID(id) || limit < 1 || limit > MaxLogLimit {
		return page, ErrInvalid
	}
	c := logCursor{Idx: -1}
	if cursor != "" {
		if err := decodeCursor(cursor, &c); err != nil {
			return page, err
		}
	}
	var deleted bool
	err := s.db.QueryRowContext(ctx, s.d.q("SELECT deleted FROM "+s.d.t("chats")+" WHERE scope = ? AND id = ?"), scope, id).Scan(&deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return page, ErrNotFound
	}
	if err != nil {
		return page, err
	}
	if deleted {
		return page, ErrDeleted
	}
	rows, err := s.db.QueryContext(ctx, s.d.q("SELECT seq, idx, body FROM "+s.d.t("chat_rows")+
		" WHERE scope = ? AND chat_id = ? AND (seq, idx) > (?, ?) ORDER BY seq, idx LIMIT ?"),
		scope, id, c.Seq, c.Idx, limit+1)
	if err != nil {
		return page, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var row Row
		var body string
		if err = rows.Scan(&row.Seq, &row.Idx, &body); err != nil {
			return page, err
		}
		if len(page.Rows) == limit {
			last := page.Rows[limit-1]
			page.NextCursor = encodeCursor(logCursor{Seq: last.Seq, Idx: last.Idx})
			break
		}
		row.Body = json.RawMessage(body)
		page.Rows = append(page.Rows, row)
	}
	return page, rows.Err()
}

func validCommit(c Commit) bool {
	if c.Epoch < 1 || c.Seq < 1 || len(c.Digest) > maxDigestBytes || !utf8.ValidString(c.Digest) {
		return false
	}
	for _, row := range c.Rows {
		if len(row.Body) == 0 || !utf8.Valid(row.Body) || !json.Valid(row.Body) ||
			len(row.Key) > maxKeyBytes || !utf8.ValidString(row.Key) || strings.ContainsRune(row.Key, 0) ||
			row.Replace && row.Key == "" {
			return false
		}
	}
	return true
}

func (s *sqlStore) Commit(ctx context.Context, scope, id string, c Commit) (CommitResult, error) {
	var result CommitResult
	if scope == "" || !ValidID(id) || !validCommit(c) {
		return result, ErrInvalid
	}
	title := NormalizeTitle(c.Title)
	err := s.write(ctx, func(tx *sql.Tx) error {
		chat, err := s.lockChat(ctx, tx, scope, id)
		if err != nil {
			return err
		}
		if c.Epoch != chat.epoch {
			return &ConflictError{Reason: ReasonLease}
		}
		if c.Seq == chat.lastSeq && c.Digest == chat.lastDigest {
			result = CommitResult{Seq: chat.lastSeq, UpdatedAt: micros(chat.updated)}
			return nil // Retry of a commit whose response was lost.
		}
		if c.Seq <= chat.lastSeq {
			return &ConflictError{Reason: ReasonSequence}
		}
		var removed, added int64
		replaced := map[string]bool{}
		for _, row := range c.Rows {
			if !row.Replace || replaced[row.Key] {
				continue
			}
			replaced[row.Key] = true
			var size int64
			if err = tx.QueryRowContext(ctx, s.d.q("SELECT COALESCE(SUM("+s.d.byteLength("body")+"), 0) FROM "+s.d.t("chat_rows")+
				" WHERE scope = ? AND chat_id = ? AND key = ? AND seq < ?"), scope, id, row.Key, c.Seq).Scan(&size); err != nil {
				return err
			}
			if size == 0 {
				continue // No earlier rows (bodies are never empty).
			}
			if _, err = s.exec(ctx, tx, "DELETE FROM "+s.d.t("chat_rows")+" WHERE scope = ? AND chat_id = ? AND key = ? AND seq < ?", scope, id, row.Key, c.Seq); err != nil {
				return err
			}
			removed += size
		}
		for start := 0; start < len(c.Rows); start += insertChunkRows {
			end := min(start+insertChunkRows, len(c.Rows))
			values := make([]string, 0, end-start)
			args := make([]any, 0, 6*(end-start))
			for i := start; i < end; i++ {
				row := c.Rows[i]
				var key any
				if row.Key != "" {
					key = row.Key
				}
				values = append(values, "(?, ?, ?, ?, ?, ?)")
				args = append(args, scope, id, c.Seq, i, key, string(row.Body))
				added += int64(len(row.Body))
			}
			if _, err = s.exec(ctx, tx, "INSERT INTO "+s.d.t("chat_rows")+" (scope, chat_id, seq, idx, key, body) VALUES "+strings.Join(values, ", "), args...); err != nil {
				return err
			}
		}
		now, err := s.now(ctx, tx)
		if err != nil {
			return err
		}
		now = max(now, chat.updated)
		if title == "" {
			title = chat.title
		}
		if _, err = s.exec(ctx, tx, "UPDATE "+s.d.t("chats")+" SET last_seq = ?, last_digest = ?, updated_at = ?, title = ?, bytes = bytes + ? WHERE scope = ? AND id = ?",
			c.Seq, c.Digest, now, title, added-removed, scope, id); err != nil {
			return err
		}
		result = CommitResult{Seq: c.Seq, UpdatedAt: micros(now)}
		return nil
	})
	return result, err
}

func (s *sqlStore) Rename(ctx context.Context, scope, id, title string) (Chat, error) {
	var result Chat
	if scope == "" || !ValidID(id) {
		return result, ErrInvalid
	}
	title = NormalizeTitle(title)
	err := s.write(ctx, func(tx *sql.Tx) error {
		c, err := s.lockChat(ctx, tx, scope, id)
		if err != nil {
			return err
		}
		if _, err = s.exec(ctx, tx, "UPDATE "+s.d.t("chats")+" SET title = ? WHERE scope = ? AND id = ?", title, scope, id); err != nil {
			return err
		}
		result = Chat{ID: id, Title: title, CreatedAt: micros(c.created), UpdatedAt: micros(c.updated)}
		return nil
	})
	return result, err
}

// Delete removes a chat's log and leaves a tombstone, so a stale writer can
// neither commit to nor recreate it. Deleting an unknown chat also leaves one.
func (s *sqlStore) Delete(ctx context.Context, scope, id string) error {
	if scope == "" || !ValidID(id) {
		return ErrInvalid
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		now, err := s.now(ctx, tx)
		if err != nil {
			return err
		}
		// Lock the chat row before its log rows, in the same order as commits.
		if _, err = s.exec(ctx, tx, "INSERT INTO "+s.d.t("chats")+" (scope, id, title, created_at, updated_at, deleted) VALUES (?, ?, '', ?, ?, true)"+
			" ON CONFLICT (scope, id) DO UPDATE SET deleted = true, title = '', bytes = 0, last_digest = '', updated_at = excluded.updated_at",
			scope, id, now, now); err != nil {
			return err
		}
		_, err = s.exec(ctx, tx, "DELETE FROM "+s.d.t("chat_rows")+" WHERE scope = ? AND chat_id = ?", scope, id)
		return err
	})
}
