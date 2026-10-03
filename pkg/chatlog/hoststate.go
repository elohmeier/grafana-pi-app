package chatlog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// HostState stores the assistant host's own state (which chat belongs to which
// thread, alert episodes) as versioned JSON documents per service account, so
// a standby replica can take over. A write names the version it replaces; a
// replica that lost its leadership cannot overwrite a newer state.
type HostState interface {
	// HostState returns a document and its version; a missing document has version 0.
	HostState(ctx context.Context, scope, key string) (json.RawMessage, int64, error)
	// SetHostState replaces the document if it still has version expected, and returns the new version.
	SetHostState(ctx context.Context, scope, key string, expected int64, body json.RawMessage) (int64, error)
}

// ReasonVersion means the host state changed since the writer read it.
const ReasonVersion = "version"

func (s *sqlStore) HostState(ctx context.Context, scope, key string) (json.RawMessage, int64, error) {
	if scope == "" || key == "" {
		return nil, 0, ErrInvalid
	}
	var body string
	var version int64
	err := s.db.QueryRowContext(ctx, s.d.q("SELECT body, version FROM "+s.d.t("host_state")+" WHERE scope = ? AND key = ?"), scope, key).Scan(&body, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, nil
	}
	return json.RawMessage(body), version, err
}

func (s *sqlStore) SetHostState(ctx context.Context, scope, key string, expected int64, body json.RawMessage) (int64, error) {
	if scope == "" || key == "" || !json.Valid(body) {
		return 0, ErrInvalid
	}
	next := expected + 1
	err := s.write(ctx, func(tx *sql.Tx) error {
		now, err := s.now(ctx, tx)
		if err != nil {
			return err
		}
		var result sql.Result
		if expected == 0 {
			result, err = s.exec(ctx, tx, "INSERT INTO "+s.d.t("host_state")+" (scope, key, version, body, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT (scope, key) DO NOTHING",
				scope, key, string(body), now)
		} else {
			result, err = s.exec(ctx, tx, "UPDATE "+s.d.t("host_state")+" SET version = ?, body = ?, updated_at = ? WHERE scope = ? AND key = ? AND version = ?",
				next, string(body), now, scope, key, expected)
		}
		if err != nil {
			return err
		}
		if rows, err := result.RowsAffected(); err != nil || rows != 1 {
			if err != nil {
				return err
			}
			return &ConflictError{Reason: ReasonVersion}
		}
		return nil
	})
	return next, err
}
