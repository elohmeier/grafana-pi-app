package chatlog

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

var schemaIdentifier = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

// ValidSchema reports whether schema is an acceptable dedicated PostgreSQL schema.
func ValidSchema(schema string) bool {
	return schemaIdentifier.MatchString(schema) && schema != "public" && schema != "information_schema" && !strings.HasPrefix(schema, "pg_")
}

func lockKey(value string) int64 {
	sum := sha256.Sum256([]byte(value))
	return int64(binary.BigEndian.Uint64(sum[:8]))
}

// OpenPostgres connects to PostgreSQL and migrates the chat tables in a
// dedicated schema. The schema is created when missing; a pre-provisioned
// schema needs no database-wide CREATE privilege.
func OpenPostgres(ctx context.Context, dsn, schema string) (Store, error) {
	if !ValidSchema(schema) {
		return nil, errors.New("invalid dedicated chat schema")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid chat PostgreSQL connection configuration")
	}
	cfg.MaxConns = 4
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams["application_name"] = "grafana-pi-chats"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	db := stdlib.OpenDBFromPool(pool)
	quoted := pgx.Identifier{schema}.Sanitize()
	s := &sqlStore{
		db: db,
		d:  dialect{postgres: true, prefix: quoted + ".", backend: "PostgreSQL"},
		close: func() error {
			err := db.Close()
			pool.Close()
			return err
		},
	}
	err = s.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", lockKey("grafana-pi:chatlog-migrations:"+quoted)); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)", schema).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			if _, err := tx.ExecContext(ctx, "CREATE SCHEMA "+quoted); err != nil {
				return err
			}
		}
		return s.migrate(ctx, tx)
	})
	if err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}
