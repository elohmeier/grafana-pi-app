package chatlog

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

// IdentityLink connects a chat platform account to a Grafana user.
type IdentityLink = api.IdentityLink

// LinkCodeTTL is how long a link code can be confirmed.
const LinkCodeTTL = 15 * time.Minute

// Links stores chat platform accounts linked to Grafana users. A link code is
// created for a platform account and confirmed by the Grafana user who opens
// it, which proves control of both accounts.
type Links interface {
	CreateLinkCode(ctx context.Context, platform, platformUser, displayName string) (code string, expires time.Time, err error)
	// LinkCode describes an unexpired code without using it.
	LinkCode(ctx context.Context, code string) (IdentityLink, error)
	// ConfirmLinkCode links the code's platform account to the Grafana user and uses up the code.
	ConfirmLinkCode(ctx context.Context, code string, orgID int64, userUID, login string) (IdentityLink, error)
	// SetLink links an account directly, for example by a verified email address.
	SetLink(ctx context.Context, link IdentityLink) (IdentityLink, error)
	Link(ctx context.Context, platform, platformUser string) (IdentityLink, error)
	Unlink(ctx context.Context, platform, platformUser string) error
	// UserLinks lists the platform accounts linked to a Grafana user.
	UserLinks(ctx context.Context, orgID int64, userUID string) ([]IdentityLink, error)
}

func hashCode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

func (s *sqlStore) CreateLinkCode(ctx context.Context, platform, platformUser, displayName string) (string, time.Time, error) {
	if platform == "" || platformUser == "" {
		return "", time.Time{}, ErrInvalid
	}
	random := make([]byte, 20)
	if _, err := rand.Read(random); err != nil {
		return "", time.Time{}, err
	}
	code := hex.EncodeToString(random)
	var expires int64
	err := s.write(ctx, func(tx *sql.Tx) error {
		now, err := s.now(ctx, tx)
		if err != nil {
			return err
		}
		expires = now + LinkCodeTTL.Microseconds()
		// Expired codes are removed with each new one.
		if _, err = s.exec(ctx, tx, "DELETE FROM "+s.d.t("identity_link_codes")+" WHERE expires_at < ?", now); err != nil {
			return err
		}
		_, err = s.exec(ctx, tx, "INSERT INTO "+s.d.t("identity_link_codes")+" (code_hash, platform, platform_user, display_name, expires_at) VALUES (?, ?, ?, ?, ?)",
			hashCode(code), platform, platformUser, displayName, expires)
		return err
	})
	return code, micros(expires), err
}

func (s *sqlStore) LinkCode(ctx context.Context, code string) (IdentityLink, error) {
	var link IdentityLink
	var expires int64
	err := s.db.QueryRowContext(ctx, s.d.q("SELECT platform, platform_user, display_name, expires_at FROM "+s.d.t("identity_link_codes")+" WHERE code_hash = ?"), hashCode(code)).
		Scan(&link.Platform, &link.PlatformUser, &link.DisplayName, &expires)
	if errors.Is(err, sql.ErrNoRows) || err == nil && expires < time.Now().UnixMicro() {
		return link, ErrNotFound
	}
	return link, err
}

func (s *sqlStore) ConfirmLinkCode(ctx context.Context, code string, orgID int64, userUID, login string) (IdentityLink, error) {
	var link IdentityLink
	if userUID == "" {
		return link, ErrInvalid
	}
	err := s.write(ctx, func(tx *sql.Tx) error {
		now, err := s.now(ctx, tx)
		if err != nil {
			return err
		}
		var expires int64
		err = tx.QueryRowContext(ctx, s.d.q("SELECT platform, platform_user, display_name, expires_at FROM "+s.d.t("identity_link_codes")+" WHERE code_hash = ?"+s.d.forUpdate()), hashCode(code)).
			Scan(&link.Platform, &link.PlatformUser, &link.DisplayName, &expires)
		if errors.Is(err, sql.ErrNoRows) || err == nil && expires < now {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if _, err = s.exec(ctx, tx, "DELETE FROM "+s.d.t("identity_link_codes")+" WHERE code_hash = ?", hashCode(code)); err != nil {
			return err
		}
		link.OrgID, link.UserUID, link.UserLogin, link.Source, link.LinkedAt = orgID, userUID, login, "code", micros(now)
		return s.upsertLink(ctx, tx, link, now)
	})
	return link, err
}

func (s *sqlStore) SetLink(ctx context.Context, link IdentityLink) (IdentityLink, error) {
	if link.Platform == "" || link.PlatformUser == "" || link.UserUID == "" || link.Source == "" {
		return link, ErrInvalid
	}
	err := s.write(ctx, func(tx *sql.Tx) error {
		now, err := s.now(ctx, tx)
		if err != nil {
			return err
		}
		link.LinkedAt = micros(now)
		return s.upsertLink(ctx, tx, link, now)
	})
	return link, err
}

func (s *sqlStore) upsertLink(ctx context.Context, tx *sql.Tx, link IdentityLink, now int64) error {
	_, err := s.exec(ctx, tx, "INSERT INTO "+s.d.t("identity_links")+" (platform, platform_user, display_name, org_id, user_uid, user_login, source, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "+
		"ON CONFLICT (platform, platform_user) DO UPDATE SET display_name = excluded.display_name, org_id = excluded.org_id, user_uid = excluded.user_uid, user_login = excluded.user_login, source = excluded.source, linked_at = excluded.linked_at",
		link.Platform, link.PlatformUser, link.DisplayName, link.OrgID, link.UserUID, link.UserLogin, link.Source, now)
	return err
}

func (s *sqlStore) Link(ctx context.Context, platform, platformUser string) (IdentityLink, error) {
	var link IdentityLink
	var linked int64
	err := s.db.QueryRowContext(ctx, s.d.q("SELECT platform, platform_user, display_name, org_id, user_uid, user_login, source, linked_at FROM "+s.d.t("identity_links")+" WHERE platform = ? AND platform_user = ?"), platform, platformUser).
		Scan(&link.Platform, &link.PlatformUser, &link.DisplayName, &link.OrgID, &link.UserUID, &link.UserLogin, &link.Source, &linked)
	if errors.Is(err, sql.ErrNoRows) {
		return link, ErrNotFound
	}
	link.LinkedAt = micros(linked)
	return link, err
}

func (s *sqlStore) Unlink(ctx context.Context, platform, platformUser string) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		_, err := s.exec(ctx, tx, "DELETE FROM "+s.d.t("identity_links")+" WHERE platform = ? AND platform_user = ?", platform, platformUser)
		return err
	})
}

func (s *sqlStore) UserLinks(ctx context.Context, orgID int64, userUID string) ([]IdentityLink, error) {
	links := []IdentityLink{}
	rows, err := s.db.QueryContext(ctx, s.d.q("SELECT platform, platform_user, display_name, org_id, user_uid, user_login, source, linked_at FROM "+s.d.t("identity_links")+" WHERE org_id = ? AND user_uid = ? ORDER BY platform, platform_user"), orgID, userUID)
	if err != nil {
		return links, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var link IdentityLink
		var linked int64
		if err = rows.Scan(&link.Platform, &link.PlatformUser, &link.DisplayName, &link.OrgID, &link.UserUID, &link.UserLogin, &link.Source, &linked); err != nil {
			return links, err
		}
		link.LinkedAt = micros(linked)
		links = append(links, link)
	}
	return links, rows.Err()
}
