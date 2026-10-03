package chatlog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type opener func(t *testing.T) Store

func sqliteStore(t *testing.T) Store {
	t.Helper()
	s, err := OpenSQLite(t.Context(), filepath.Join(t.TempDir(), "nested", "chats.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func postgresStore(t *testing.T) Store {
	t.Helper()
	dsn := os.Getenv("PI_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set PI_TEST_POSTGRES_DSN to run PostgreSQL integration tests")
	}
	schema := fmt.Sprintf("pi_test_%d", time.Now().UnixNano())
	s, err := OpenPostgres(t.Context(), dsn, schema)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := s.(*sqlStore).db.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error(err)
		}
		_ = s.Close()
	})
	return s
}

func TestSQLiteStore(t *testing.T)   { runContract(t, sqliteStore) }
func TestPostgresStore(t *testing.T) { runContract(t, postgresStore) }

func TestPostgresReplicasShareLeases(t *testing.T) {
	dsn := os.Getenv("PI_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set PI_TEST_POSTGRES_DSN to run PostgreSQL integration tests")
	}
	a := postgresStore(t)
	b, err := OpenPostgres(t.Context(), dsn, strings.Trim(a.(*sqlStore).d.prefix, `".`))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = b.Close() }()
	ctx := t.Context()
	first, err := a.Open(ctx, "s", "chat", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.Open(ctx, "s", "chat", "", true); err != nil {
		t.Fatal(err)
	}
	if _, err = a.Commit(ctx, "s", "chat", commit(first.Epoch, 1, "d1", row(`{}`))); !isConflict(err, ReasonLease) {
		t.Fatalf("stale replica writer accepted: %v", err)
	}
}

func row(body string) CommitRow { return CommitRow{Body: json.RawMessage(body)} }
func keyed(body, key string, replace bool) CommitRow {
	return CommitRow{Body: json.RawMessage(body), Key: key, Replace: replace}
}
func commit(epoch, seq int64, digest string, rows ...CommitRow) Commit {
	return Commit{Epoch: epoch, Seq: seq, Digest: digest, Rows: rows}
}
func isConflict(err error, reason string) bool {
	var conflict *ConflictError
	return errors.As(err, &conflict) && conflict.Reason == reason && errors.Is(err, ErrConflict)
}

func readAll(t *testing.T, s Store, scope, id string, limit int) []Row {
	t.Helper()
	var all []Row
	cursor := ""
	for {
		page, err := s.Log(t.Context(), scope, id, cursor, limit)
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, page.Rows...)
		if page.NextCursor == "" {
			return all
		}
		if len(page.Rows) != limit {
			t.Fatalf("short page with cursor: %d", len(page.Rows))
		}
		cursor = page.NextCursor
	}
}

func bodies(rows []Row) string {
	parts := make([]string, len(rows))
	for i, r := range rows {
		parts[i] = fmt.Sprintf("%d.%d=%s", r.Seq, r.Idx, r.Body)
	}
	return strings.Join(parts, " ")
}

func storedBytes(t *testing.T, s Store, scope, id string) int64 {
	t.Helper()
	ss := s.(*sqlStore)
	var n int64
	if err := ss.db.QueryRowContext(t.Context(), ss.d.q("SELECT bytes FROM "+ss.d.t("chats")+" WHERE scope = ? AND id = ?"), scope, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func runContract(t *testing.T, open opener) {
	t.Run("open bumps epoch and keeps metadata", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		first, err := s.Open(ctx, "s", "chat-1", "  First title  ", true)
		if err != nil {
			t.Fatal(err)
		}
		if first.Epoch != 1 || first.LastSeq != 0 || first.Title != "First title" || first.CreatedAt.IsZero() || !first.CreatedAt.Equal(first.UpdatedAt) {
			t.Fatalf("%+v", first)
		}
		second, err := s.Open(ctx, "s", "chat-1", "ignored", true)
		if err != nil {
			t.Fatal(err)
		}
		if second.Epoch != 2 || second.Title != "First title" || !second.CreatedAt.Equal(first.CreatedAt) {
			t.Fatalf("%+v", second)
		}
		if _, err := s.Open(ctx, "s", "missing", "", false); !errors.Is(err, ErrNotFound) {
			t.Fatalf("open without create of a missing chat: %v", err)
		}
		if reopened, err := s.Open(ctx, "s", "chat-1", "", false); err != nil || reopened.Epoch != 3 {
			t.Fatalf("open without create of an existing chat: %+v %v", reopened, err)
		}
		long, err := s.Open(ctx, "s", "chat-2", strings.Repeat("ä", 250), true)
		if err != nil || long.Title != strings.Repeat("ä", MaxTitleRunes) {
			t.Fatalf("%q %v", long.Title, err)
		}
		for _, id := range []string{"", "a/b", "a b", strings.Repeat("x", 65), "ü"} {
			if _, err := s.Open(ctx, "s", id, "", true); !errors.Is(err, ErrInvalid) {
				t.Fatalf("accepted id %q: %v", id, err)
			}
		}
	})

	t.Run("commit sequence lease and idempotent retry", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		if _, err := s.Commit(ctx, "s", "missing", commit(1, 1, "d", row(`1`))); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown chat: %v", err)
		}
		a, _ := s.Open(ctx, "s", "c", "", true)
		r1, err := s.Commit(ctx, "s", "c", commit(a.Epoch, 1, "d1", row(`{"a":1}`)))
		if err != nil || r1.Seq != 1 || r1.UpdatedAt.Before(a.UpdatedAt) {
			t.Fatalf("%+v %v", r1, err)
		}
		retry, err := s.Commit(ctx, "s", "c", commit(a.Epoch, 1, "d1", row(`{"a":1}`)))
		if err != nil || retry != r1 {
			t.Fatalf("retry %+v %v", retry, err)
		}
		if _, err = s.Commit(ctx, "s", "c", commit(a.Epoch, 1, "other", row(`{}`))); !isConflict(err, ReasonSequence) {
			t.Fatalf("same seq other digest: %v", err)
		}
		if _, err = s.Commit(ctx, "s", "c", commit(a.Epoch, 3, "d3", row(`3`))); err != nil {
			t.Fatal("gaps are allowed:", err)
		}
		if _, err = s.Commit(ctx, "s", "c", commit(a.Epoch, 2, "d2", row(`2`))); !isConflict(err, ReasonSequence) {
			t.Fatalf("older seq: %v", err)
		}
		b, _ := s.Open(ctx, "s", "c", "", true)
		if b.LastSeq != 3 {
			t.Fatalf("%+v", b)
		}
		if _, err = s.Commit(ctx, "s", "c", commit(a.Epoch, 4, "d4", row(`4`))); !isConflict(err, ReasonLease) {
			t.Fatalf("stale writer: %v", err)
		}
		if _, err = s.Commit(ctx, "s", "c", commit(a.Epoch, 3, "d3", row(`3`))); !isConflict(err, ReasonLease) {
			t.Fatalf("stale retry: %v", err)
		}
		if _, err = s.Commit(ctx, "s", "c", commit(b.Epoch, 4, "d4", row(`4`))); err != nil {
			t.Fatal(err)
		}
		if got := bodies(readAll(t, s, "s", "c", 100)); got != "1.0={\"a\":1} 3.0=3 4.0=4" {
			t.Fatal(got)
		}
		for name, bad := range map[string]Commit{
			"zero epoch":      commit(0, 5, "d"),
			"zero seq":        commit(b.Epoch, 0, "d"),
			"missing body":    commit(b.Epoch, 5, "d", CommitRow{}),
			"invalid json":    commit(b.Epoch, 5, "d", row(`{`)),
			"replace no key":  commit(b.Epoch, 5, "d", CommitRow{Body: json.RawMessage(`1`), Replace: true}),
			"invalid utf8":    commit(b.Epoch, 5, "d", row("\"\xff\"")),
			"oversize digest": commit(b.Epoch, 5, strings.Repeat("d", 513)),
		} {
			if _, err := s.Commit(ctx, "s", "c", bad); !errors.Is(err, ErrInvalid) {
				t.Errorf("%s accepted: %v", name, err)
			}
		}
	})

	t.Run("commit title and empty commits", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		a, _ := s.Open(ctx, "s", "c", "start", true)
		c := commit(a.Epoch, 1, "d1")
		c.Title = " Renamed "
		if _, err := s.Commit(ctx, "s", "c", c); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Commit(ctx, "s", "c", commit(a.Epoch, 2, "d2", row(`1`))); err != nil {
			t.Fatal(err)
		}
		page, _ := s.List(ctx, "s", "", 10)
		if len(page.Items) != 1 || page.Items[0].Title != "Renamed" {
			t.Fatalf("%+v", page)
		}
	})

	t.Run("replace prunes earlier keyed rows", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		a, _ := s.Open(ctx, "s", "c", "", true)
		mustCommit := func(seq int64, rows ...CommitRow) {
			t.Helper()
			if _, err := s.Commit(ctx, "s", "c", commit(a.Epoch, seq, fmt.Sprint("d", seq), rows...)); err != nil {
				t.Fatal(err)
			}
		}
		mustCommit(1, row(`"m1"`), keyed(`"state-1"`, "state", false), keyed(`"other-1"`, "other", false))
		mustCommit(2, keyed(`"state-2"`, "state", false), row(`"m2"`))
		mustCommit(3, keyed(`"state-3a"`, "state", true), keyed(`"state-3b"`, "state", true), row(`"m3"`))
		got := bodies(readAll(t, s, "s", "c", 100))
		want := `1.0="m1" 1.2="other-1" 2.1="m2" 3.0="state-3a" 3.1="state-3b" 3.2="m3"`
		if got != want {
			t.Fatalf("got  %s\nwant %s", got, want)
		}
		var size int64
		for _, r := range readAll(t, s, "s", "c", 100) {
			size += int64(len(r.Body))
		}
		if stored := storedBytes(t, s, "s", "c"); stored != size {
			t.Fatalf("bytes %d, rows %d", stored, size)
		}
		// Another chat's rows with the same key are untouched.
		other, _ := s.Open(ctx, "s", "d", "", true)
		if _, err := s.Commit(ctx, "s", "d", commit(other.Epoch, 1, "x", keyed(`"d-state"`, "state", false))); err != nil {
			t.Fatal(err)
		}
		mustCommit(4, keyed(`"state-4"`, "state", true))
		if got := bodies(readAll(t, s, "s", "d", 100)); got != `1.0="d-state"` {
			t.Fatal(got)
		}
	})

	t.Run("log pagination round-trips exact JSON", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		a, _ := s.Open(ctx, "s", "c", "", true)
		var want []string
		for seq := int64(1); seq <= 7; seq++ {
			var rows []CommitRow
			for i := 0; i < int(seq%3)+1; i++ {
				body := fmt.Sprintf("{ \"seq\" : %d,\n \"html\":\"<b>&amp;</b>\", \"u\":\"\\u00e9 ö 🙂\", \"n\": 1.50e2 , \"z\":[ ] }", seq)
				rows = append(rows, row(body))
				want = append(want, fmt.Sprintf("%d.%d=%s", seq, i, body))
			}
			if _, err := s.Commit(ctx, "s", "c", commit(a.Epoch, seq, "d", rows...)); err != nil {
				t.Fatal(err)
			}
		}
		for _, limit := range []int{1, 2, 3, 100} {
			if got := bodies(readAll(t, s, "s", "c", limit)); got != strings.Join(want, " ") {
				t.Fatalf("limit %d:\n%s\n%s", limit, got, strings.Join(want, " "))
			}
		}
		if _, err := s.Log(ctx, "s", "c", "%%%", 10); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
		if _, err := s.Log(ctx, "s", "c", "", MaxLogLimit+1); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
		if _, err := s.Log(ctx, "s", "missing", "", 10); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
		// Reading needs no lease.
		if _, err := s.Open(ctx, "s", "c", "", true); err != nil {
			t.Fatal(err)
		}
		if len(readAll(t, s, "s", "c", 5)) != len(want) {
			t.Fatal("log changed by open")
		}
	})

	t.Run("list ordering pagination and deleted", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		epochs := map[string]int64{}
		for i := 0; i < 7; i++ {
			id := fmt.Sprintf("chat-%d", i)
			c, err := s.Open(ctx, "s", id, "title "+id, true)
			if err != nil {
				t.Fatal(err)
			}
			epochs[id] = c.Epoch
		}
		// Touch chat-2 last so it sorts first.
		if _, err := s.Commit(ctx, "s", "chat-2", commit(epochs["chat-2"], 1, "d", row(`1`))); err != nil {
			t.Fatal(err)
		}
		if err := s.Delete(ctx, "s", "chat-4"); err != nil {
			t.Fatal(err)
		}
		var ids []string
		cursor := ""
		for pages := 0; ; pages++ {
			page, err := s.List(ctx, "s", cursor, 2)
			if err != nil {
				t.Fatal(err)
			}
			for i, item := range page.Items {
				ids = append(ids, item.ID)
				if item.Title != "title "+item.ID {
					t.Fatalf("%+v", item)
				}
				if i > 0 && item.UpdatedAt.After(page.Items[i-1].UpdatedAt) {
					t.Fatal("not ordered")
				}
			}
			if page.NextCursor == "" {
				break
			}
			cursor = page.NextCursor
		}
		if len(ids) != 6 || ids[0] != "chat-2" || strings.Contains(strings.Join(ids, ","), "chat-4") {
			t.Fatal(ids)
		}
		seen := map[string]bool{}
		for _, id := range ids {
			if seen[id] {
				t.Fatal("duplicate", ids)
			}
			seen[id] = true
		}
		empty, err := s.List(ctx, "other", "", 10)
		if err != nil || len(empty.Items) != 0 || empty.Items == nil {
			t.Fatalf("%+v %v", empty, err)
		}
		if _, err = s.List(ctx, "s", "", 0); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
		if _, err = s.List(ctx, "s", "garbage!", 10); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
	})

	t.Run("same timestamps paginate by id", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		ss := s.(*sqlStore)
		for i := 0; i < 5; i++ {
			if _, err := s.Open(ctx, "s", fmt.Sprintf("c%d", i), "", true); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := ss.db.ExecContext(ctx, ss.d.q("UPDATE "+ss.d.t("chats")+" SET updated_at = ?"), int64(1_700_000_000_000_000)); err != nil {
			t.Fatal(err)
		}
		var ids []string
		cursor := ""
		for {
			page, err := s.List(ctx, "s", cursor, 2)
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range page.Items {
				ids = append(ids, item.ID)
			}
			if cursor = page.NextCursor; cursor == "" {
				break
			}
		}
		if strings.Join(ids, ",") != "c4,c3,c2,c1,c0" {
			t.Fatal(ids)
		}
	})

	t.Run("delete leaves tombstone", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		a, _ := s.Open(ctx, "s", "c", "secret title", true)
		if _, err := s.Commit(ctx, "s", "c", commit(a.Epoch, 1, "d", row(`1`), keyed(`2`, "k", false))); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if err := s.Delete(ctx, "s", "c"); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.Open(ctx, "s", "c", "", true); !errors.Is(err, ErrDeleted) {
			t.Fatalf("open: %v", err)
		}
		if _, err := s.Commit(ctx, "s", "c", commit(a.Epoch, 2, "d2", row(`1`))); !errors.Is(err, ErrDeleted) {
			t.Fatalf("commit: %v", err)
		}
		if _, err := s.Log(ctx, "s", "c", "", 10); !errors.Is(err, ErrDeleted) {
			t.Fatalf("log: %v", err)
		}
		if _, err := s.Rename(ctx, "s", "c", "x"); !errors.Is(err, ErrDeleted) {
			t.Fatalf("rename: %v", err)
		}
		ss := s.(*sqlStore)
		var rows int
		var title string
		_ = ss.db.QueryRowContext(ctx, ss.d.q("SELECT count(*) FROM "+ss.d.t("chat_rows")+" WHERE scope = ?"), "s").Scan(&rows)
		_ = ss.db.QueryRowContext(ctx, ss.d.q("SELECT title FROM "+ss.d.t("chats")+" WHERE scope = ?"), "s").Scan(&title)
		if rows != 0 || title != "" || storedBytes(t, s, "s", "c") != 0 {
			t.Fatal(rows, title)
		}
		// Deleting a chat that was never stored blocks it from being created.
		if err := s.Delete(ctx, "s", "never"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Open(ctx, "s", "never", "", true); !errors.Is(err, ErrDeleted) {
			t.Fatal(err)
		}
	})

	t.Run("rename", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		a, _ := s.Open(ctx, "s", "c", "old", true)
		renamed, err := s.Rename(ctx, "s", "c", "  new  ")
		if err != nil || renamed.Title != "new" || !renamed.UpdatedAt.Equal(a.UpdatedAt) {
			t.Fatalf("%+v %v", renamed, err)
		}
		// Renaming needs no lease and does not invalidate the writer.
		if _, err = s.Commit(ctx, "s", "c", commit(a.Epoch, 1, "d", row(`1`))); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Rename(ctx, "s", "missing", "x"); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
	})

	t.Run("scopes are isolated", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		a, _ := s.Open(ctx, "alice", "shared-id", "alice chat", true)
		if _, err := s.Commit(ctx, "alice", "shared-id", commit(a.Epoch, 1, "d", row(`"alice"`))); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Log(ctx, "bob", "shared-id", "", 10); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
		if _, err := s.Rename(ctx, "bob", "shared-id", "x"); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
		if _, err := s.Commit(ctx, "bob", "shared-id", commit(a.Epoch, 2, "d", row(`1`))); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
		b, err := s.Open(ctx, "bob", "shared-id", "bob chat", true)
		if err != nil || b.Epoch != 1 || b.Title != "bob chat" {
			t.Fatalf("%+v %v", b, err)
		}
		if err = s.Delete(ctx, "bob", "shared-id"); err != nil {
			t.Fatal(err)
		}
		if got := bodies(readAll(t, s, "alice", "shared-id", 10)); got != `1.0="alice"` {
			t.Fatal(got)
		}
		page, _ := s.List(ctx, "alice", "", 10)
		if len(page.Items) != 1 || page.Items[0].Title != "alice chat" {
			t.Fatalf("%+v", page)
		}
	})

	t.Run("concurrent writers: exactly one wins", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		const writers = 8
		var wg sync.WaitGroup
		errs := make([]error, writers)
		for i := range writers {
			wg.Go(func() {
				opened, err := s.Open(ctx, "s", "race", "", true)
				if err == nil {
					_, err = s.Commit(ctx, "s", "race", commit(opened.Epoch, 1, fmt.Sprint("writer-", i), row(fmt.Sprint(i))))
				}
				errs[i] = err
			})
		}
		wg.Wait()
		wins := 0
		for _, err := range errs {
			switch {
			case err == nil:
				wins++
			case !errors.Is(err, ErrConflict):
				t.Fatal(err)
			}
		}
		if wins != 1 || len(readAll(t, s, "s", "race", 100)) != 1 {
			t.Fatalf("%d winners: %v", wins, errs)
		}
		// Two open writers committing in parallel: only the newer epoch succeeds.
		first, _ := s.Open(ctx, "s", "pair", "", true)
		second, _ := s.Open(ctx, "s", "pair", "", true)
		results := make([]error, 2)
		for i, epoch := range []int64{first.Epoch, second.Epoch} {
			wg.Go(func() {
				for seq := int64(1); seq <= 20; seq++ {
					if _, err := s.Commit(ctx, "s", "pair", commit(epoch, seq, fmt.Sprint(i, seq), row(`1`))); err != nil {
						results[i] = err
						return
					}
				}
			})
		}
		wg.Wait()
		if !isConflict(results[0], ReasonLease) || results[1] != nil {
			t.Fatal(results)
		}
	})

	t.Run("share copies a chat into another scope", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		opened, err := s.Open(ctx, "host", "chat-1", "Alert thread", true)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.Commit(ctx, "host", "chat-1", commit(opened.Epoch, 1, "d1", row(`{"n":1}`), keyed(`{"doc":1}`, "doc", true))); err != nil {
			t.Fatal(err)
		}
		token, err := s.Share(ctx, "host", "chat-1")
		if err != nil || len(token) != 48 {
			t.Fatalf("%q %v", token, err)
		}
		if again, _ := s.Share(ctx, "host", "chat-1"); again != token {
			t.Fatalf("a chat keeps its token: %q %q", again, token)
		}
		if _, err = s.Share(ctx, "user", "chat-1"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("shared a chat of another scope: %v", err)
		}
		copied, err := s.CopyShared(ctx, token, "user", "copy-1")
		if err != nil || copied.ID != "copy-1" || copied.Title != "Alert thread" {
			t.Fatalf("%+v %v", copied, err)
		}
		if got := bodies(readAll(t, s, "user", "copy-1", 10)); got != bodies(readAll(t, s, "host", "chat-1", 10)) {
			t.Fatalf("copied rows %s", got)
		}
		// The copy continues with its own writer, after the source's sequence.
		reopened, err := s.Open(ctx, "user", "copy-1", "", false)
		if err != nil || reopened.Epoch != 1 || reopened.LastSeq != 1 {
			t.Fatalf("%+v %v", reopened, err)
		}
		if _, err = s.Commit(ctx, "user", "copy-1", commit(reopened.Epoch, 2, "d2", row(`{"n":2}`))); err != nil {
			t.Fatal(err)
		}
		if got := bodies(readAll(t, s, "host", "chat-1", 10)); strings.Contains(got, `"n":2`) {
			t.Fatalf("the copy changed the source: %s", got)
		}
		if page, _ := s.List(ctx, "user", "", 10); len(page.Items) != 1 || page.Items[0].ID != "copy-1" {
			t.Fatalf("%+v", page)
		}
		if _, err = s.CopyShared(ctx, "unknown-token", "user", "copy-2"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("copied with an unknown token: %v", err)
		}
		if _, err = s.CopyShared(ctx, token, "user", "copy-1"); err == nil {
			t.Fatal("copied over an existing chat")
		}
	})

	t.Run("link codes link a platform account once", func(t *testing.T) {
		s, ctx := open(t), t.Context()
		code, expires, err := s.CreateLinkCode(ctx, "webex", "person-1", "Alice Doe")
		if err != nil || len(code) != 40 || time.Until(expires) < 10*time.Minute {
			t.Fatalf("%q %v %v", code, expires, err)
		}
		pending, err := s.LinkCode(ctx, code)
		if err != nil || pending.Platform != "webex" || pending.PlatformUser != "person-1" || pending.DisplayName != "Alice Doe" {
			t.Fatalf("%+v %v", pending, err)
		}
		if _, err = s.Link(ctx, "webex", "person-1"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("linked before confirmation: %v", err)
		}
		link, err := s.ConfirmLinkCode(ctx, code, 1, "uid-alice", "alice")
		if err != nil || link.UserUID != "uid-alice" || link.Source != "code" {
			t.Fatalf("%+v %v", link, err)
		}
		if _, err = s.ConfirmLinkCode(ctx, code, 1, "uid-mallory", "mallory"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("a code was used twice: %v", err)
		}
		if got, err := s.Link(ctx, "webex", "person-1"); err != nil || got.UserLogin != "alice" || got.LinkedAt.IsZero() {
			t.Fatalf("%+v %v", got, err)
		}
		// A verified email links (or relinks) without a code.
		if _, err = s.SetLink(ctx, IdentityLink{Platform: "mattermost", PlatformUser: "u-1", DisplayName: "alice", OrgID: 1, UserUID: "uid-alice", UserLogin: "alice", Source: "email"}); err != nil {
			t.Fatal(err)
		}
		links, err := s.UserLinks(ctx, 1, "uid-alice")
		if err != nil || len(links) != 2 || links[0].Platform != "mattermost" || links[1].Platform != "webex" {
			t.Fatalf("%+v %v", links, err)
		}
		if err = s.Unlink(ctx, "webex", "person-1"); err != nil {
			t.Fatal(err)
		}
		if links, _ = s.UserLinks(ctx, 1, "uid-alice"); len(links) != 1 {
			t.Fatalf("%+v", links)
		}
		if _, err = s.LinkCode(ctx, "unknown"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%v", err)
		}
	})
}

func TestSQLiteSharedAcrossInstances(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chats.db")
	a, err := OpenSQLite(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	b, err := OpenSQLite(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if a.(*sqlStore).db != b.(*sqlStore).db {
		t.Fatal("instances do not share the database")
	}
	_ = a.Close()
	_ = a.Close() // Closing twice releases one reference only.
	if err = b.Ping(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Open(t.Context(), "s", "c", "", true); err != nil {
		t.Fatal(err)
	}
	_ = b.Close()
	sqliteMu.Lock()
	n := len(sqliteDBs)
	sqliteMu.Unlock()
	if n != 0 {
		t.Fatal("database not released")
	}
	c, err := OpenSQLite(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	page, err := c.List(t.Context(), "s", "", 10)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("%+v %v", page, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal(info, err)
	}
}

func TestSQLitePath(t *testing.T) {
	got, err := defaultSQLitePath("/var/lib/grafana/plugins/grafana-assistant-app/gpx_grafana_assistant_app_linux_arm64", "grafana-assistant-app")
	if err != nil || got != "/var/lib/grafana/plugin-data/grafana-assistant-app/chats.db" {
		t.Fatal(got, err)
	}
	if _, err = defaultSQLitePath("/x/y/z", "../evil"); err == nil {
		t.Fatal("accepted plugin ID with a path separator")
	}
	t.Setenv("GF_PLUGIN_SQLITE_PATH", "")
	t.Setenv("PI_SESSION_SQLITE_PATH", "/data/pi.db")
	if got, _ = SQLitePath("p"); got != "/data/pi.db" {
		t.Fatal(got)
	}
	t.Setenv("GF_PLUGIN_SQLITE_PATH", "/grafana/chats.db")
	if got, _ = SQLitePath("p"); got != "/grafana/chats.db" {
		t.Fatal(got)
	}
	t.Setenv("GF_PLUGIN_SQLITE_PATH", "")
	t.Setenv("PI_SESSION_SQLITE_PATH", "")
	if got, err = SQLitePath("p"); err != nil || !strings.HasSuffix(got, filepath.Join("plugin-data", "p", "chats.db")) {
		t.Fatal(got, err)
	}
}

// TestPostgresProvisionedSchema checks a role that owns only a pre-provisioned
// schema (no database-wide CREATE), e.g. the HA fixture's pi_sessions role.
func TestPostgresProvisionedSchema(t *testing.T) {
	dsn, schema := os.Getenv("PI_TEST_POSTGRES_SCHEMA_DSN"), os.Getenv("PI_TEST_POSTGRES_SCHEMA")
	if dsn == "" || schema == "" {
		t.Skip("set PI_TEST_POSTGRES_SCHEMA_DSN and PI_TEST_POSTGRES_SCHEMA to test a pre-provisioned schema")
	}
	s, err := OpenPostgres(t.Context(), dsn, schema)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	scope := fmt.Sprintf("test-%d", time.Now().UnixNano())
	opened, err := s.Open(t.Context(), scope, "c", "t", true)
	if err == nil {
		_, err = s.Commit(t.Context(), scope, "c", commit(opened.Epoch, 1, "d", row(`{"ok":true}`)))
	}
	if err == nil {
		err = s.Delete(t.Context(), scope, "c")
	}
	if err != nil {
		t.Fatal(err)
	}
}
