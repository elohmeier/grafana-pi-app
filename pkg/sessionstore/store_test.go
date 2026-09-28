package sessionstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func testStore(t *testing.T) (*Store, string, string) {
	t.Helper()
	dsn := os.Getenv("PI_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set PI_TEST_POSTGRES_DSN to run PostgreSQL integration tests")
	}
	schema := fmt.Sprintf("pi_test_%d", time.Now().UnixNano())
	s, err := Open(t.Context(), dsn, schema)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := s.pool.Exec(context.Background(), "DROP SCHEMA "+s.schema+" CASCADE")
		if err != nil {
			t.Error(err)
		}
		s.Close()
	})
	return s, dsn, schema
}
func write(title, request string, revision int64) Write {
	return Write{Title: title, RequestID: request, Revision: revision, Snapshot: json.RawMessage(`{"messages":[{"role":"user","content":"hello"}],"workspace":{"files":[]}}`)}
}

func TestPostgresReplicas(t *testing.T) {
	a, dsn, schema := testStore(t)
	ctx := t.Context()
	b, err := Open(ctx, dsn, schema)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	first, err := a.Mutate(ctx, "owner-a", "session", write("one", "request-1", 0), false)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 {
		t.Fatal(first)
	}
	retry, err := b.Mutate(ctx, "owner-a", "session", write("one", "request-1", 0), false)
	if err != nil || retry != first {
		t.Fatalf("retry: %+v %v", retry, err)
	}
	if _, err = b.Mutate(ctx, "owner-a", "session", write("different", "request-1", 0), false); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed retry %v", err)
	}
	if _, err = b.Get(ctx, "owner-b", "session"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owner isolation %v", err)
	}
	page, err := b.List(ctx, "owner-b", "", 30)
	if err != nil || len(page.Items) != 0 {
		t.Fatal(page, err)
	}
	// Two instances both edit revision one: exactly one wins, regardless of routing.
	var wg sync.WaitGroup
	outcomes := make(chan error, 2)
	for i, s := range []*Store{a, b} {
		wg.Add(1)
		go func(i int, s *Store) {
			defer wg.Done()
			_, e := s.Mutate(ctx, "owner-a", "session", write(fmt.Sprint(i), fmt.Sprintf("concurrent-%d", i), 1), false)
			outcomes <- e
		}(i, s)
	}
	wg.Wait()
	close(outcomes)
	ok, conflicts := 0, 0
	for e := range outcomes {
		if e == nil {
			ok++
		} else if errors.Is(e, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatalf("wins=%d conflicts=%d", ok, conflicts)
	}
	loaded, err := b.Get(ctx, "owner-a", "session")
	if err != nil || loaded.Revision != 2 || !strings.Contains(string(loaded.Snapshot), "hello") {
		t.Fatal(loaded, err)
	}
	_, err = a.Mutate(ctx, "owner-a", "session", Write{RequestID: "delete-1", Revision: 2}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.Get(ctx, "owner-a", "session"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = b.Mutate(ctx, "owner-a", "session", write("resurrect", "request-4", 0), false); !errors.Is(err, ErrConflict) {
		t.Fatalf("resurrection: %v", err)
	}
	// A resumed migration cannot resurrect tombstones or overwrite edited sessions.
	legacy := write("legacy", "legacy-1", 0)
	legacy.Import = true
	if _, err = b.Mutate(ctx, "owner-a", "session", legacy, false); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Get(ctx, "owner-a", "session"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if err = a.CompleteImport(ctx, "owner-a"); err != nil {
		t.Fatal(err)
	}
	if done, err := b.ImportComplete(ctx, "owner-a"); err != nil || !done {
		t.Fatal(done, err)
	}
	if done, err := b.ImportComplete(ctx, "owner-b"); err != nil || done {
		t.Fatal(done, err)
	}
}

func TestPostgresPaginationAndSchemaIsolation(t *testing.T) {
	s, dsn, _ := testStore(t)
	other, _, _ := testStore(t)
	ctx := t.Context()
	when := time.Now().UTC().Truncate(time.Microsecond).Add(-time.Hour)
	for i := 0; i < 75; i++ {
		w := write("history", fmt.Sprintf("import-%03d", i), 0)
		w.Import = true
		w.CreatedAt = when
		w.UpdatedAt = when
		w.Snapshot = json.RawMessage(`{"messages":[{"content":"` + strings.Repeat("x", 64000) + `"}]}`)
		if _, err := s.Mutate(ctx, "owner", fmt.Sprintf("id-%03d", i), w, false); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := s.List(ctx, "owner", cursor, 30)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(page)
		if len(raw) > 10000 {
			t.Fatalf("list leaked bodies: %d bytes", len(raw))
		}
		for _, m := range page.Items {
			if seen[m.ID] {
				t.Fatalf("duplicate: %s", m.ID)
			}
			seen[m.ID] = true
			if !m.CreatedAt.Equal(when) {
				t.Fatal("import timestamp changed")
			}
		}
		cursor = page.NextCursor
		if cursor == "" {
			break
		}
	}
	if len(seen) != 75 {
		t.Fatal(len(seen))
	}
	if _, err := s.List(ctx, "owner", "invalid", 30); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if _, err := s.List(ctx, "owner", "", 101); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if page, err := other.List(ctx, "owner", "", 30); err != nil || len(page.Items) != 0 {
		t.Fatal(page, err)
	}
	// The same schema can be initialized concurrently by new plugin processes.
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			store, err := Open(ctx, dsn, s.schema[1:len(s.schema)-1])
			if err != nil {
				t.Error(err)
			} else {
				store.Close()
			}
		}()
	}
	wg.Wait()
}

func TestDedicatedRoleOnGrafanaDatabase(t *testing.T) {
	dsn := os.Getenv("PI_TEST_RESTRICTED_DSN")
	if dsn == "" {
		t.Skip("set PI_TEST_RESTRICTED_DSN with precreated grafana_pi schema")
	}
	s, err := Open(t.Context(), dsn, "grafana_pi")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var allowed bool
	if err = s.pool.QueryRow(t.Context(), "SELECT has_database_privilege(current_user,current_database(),'CREATE')").Scan(&allowed); err != nil || allowed {
		t.Fatalf("role must not have CREATE: %v %v", allowed, err)
	}
	if _, err = s.pool.Exec(t.Context(), "CREATE TABLE public.pi_should_not_exist(id int)"); err == nil {
		t.Fatal("session role can write Grafana schema")
	}
}

func TestRejectUnsafeSchema(t *testing.T) {
	for _, schema := range []string{"public", "pg_catalog", "information_schema", "foo;drop schema public", "foo.bar", ""} {
		if _, err := Open(t.Context(), "postgres://invalid", schema); err == nil {
			t.Fatal(schema)
		}
	}
}

func TestSnapshotFailureRollsBackMetadataAndReceipt(t *testing.T) {
	s, _, _ := testStore(t)
	ctx := t.Context()
	if _, err := s.Mutate(ctx, "owner", "session", write("original", "original-request", 0), false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, "ALTER TABLE "+s.schema+".snapshots ADD CONSTRAINT reject_fixture CHECK (NOT payload ? 'reject')"); err != nil {
		t.Fatal(err)
	}
	bad := write("must roll back", "rollback-request", 1)
	bad.Snapshot = json.RawMessage(`{"messages":[],"reject":true}`)
	if _, err := s.Mutate(ctx, "owner", "session", bad, false); err == nil {
		t.Fatal("expected snapshot constraint failure")
	}
	got, err := s.Get(ctx, "owner", "session")
	if err != nil || got.Revision != 1 || got.Title != "original" {
		t.Fatalf("partial write: %+v %v", got, err)
	}
	if _, err := s.Mutate(ctx, "owner", "session", write("recovered", "rollback-request", 1), false); err != nil {
		t.Fatal(err)
	}
}

// Run with -bench=SessionList -benchtime=100x and a disposable database.
func BenchmarkSessionList(b *testing.B) {
	dsn := os.Getenv("PI_TEST_POSTGRES_DSN")
	if dsn == "" {
		b.Skip("set PI_TEST_POSTGRES_DSN")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("pi_bench_%d", time.Now().UnixNano())
	s, err := Open(ctx, dsn, schema)
	if err != nil {
		b.Fatal(err)
	}
	defer s.Close()
	defer func() {
		if _, err := s.pool.Exec(ctx, "DROP SCHEMA "+s.schema+" CASCADE"); err != nil {
			b.Error(err)
		}
	}()
	// SQL fixture keeps setup cheap while creating 1,000 independent 64KB bodies.
	_, err = s.pool.Exec(ctx, "INSERT INTO "+s.schema+".sessions SELECT 'owner',i::text,'History '||i,now(),now(),1,false FROM generate_series(1,1000) i; INSERT INTO "+s.schema+".snapshots SELECT scope,id,jsonb_build_object('messages',jsonb_build_array(repeat(md5(id),2000))) FROM "+s.schema+".sessions")
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		page, err := s.List(ctx, "owner", "", 30)
		if err != nil {
			b.Fatal(err)
		}
		raw, _ := json.Marshal(page)
		b.ReportMetric(float64(len(raw)), "response-bytes")
	}
}
