package api

import (
	"encoding/json"
	"time"
)

// Chat is the metadata shown in chat lists.
type Chat struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ChatPage is the response of GET /chats.
type ChatPage struct {
	Items      []Chat `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// OpenChatRequest is the body of POST /chats/{id}/open.
type OpenChatRequest struct {
	Title string `json:"title,omitempty"`
	// Create defaults to true; false opens only an existing chat.
	Create *bool `json:"create,omitempty"`
}

// OpenedChat is returned to the writer that opened a chat.
type OpenedChat struct {
	Chat `tstype:",extends"`
	// Epoch identifies the writer; commits with an older epoch are refused.
	Epoch   int64 `json:"epoch"`
	LastSeq int64 `json:"lastSeq"`
}

// ChatLogRow is one stored row of a commit. Body is the exact JSON that was committed.
type ChatLogRow struct {
	Seq  int64           `json:"seq"`
	Idx  int             `json:"idx"`
	Body json.RawMessage `json:"body"`
}

// ChatLogPage is the response of GET /chats/{id}/log.
type ChatLogPage struct {
	Rows       []ChatLogRow `json:"rows"`
	NextCursor string       `json:"nextCursor,omitempty"`
}

// ChatCommitRow is one row of a commit.
type ChatCommitRow struct {
	Body json.RawMessage `json:"body"`
	// Key identifies rows that later commits may replace.
	Key string `json:"key,omitempty"`
	// Replace deletes earlier rows with the same key.
	Replace bool `json:"replace,omitempty"`
}

// ChatCommit is the body of POST /chats/{id}/commits.
type ChatCommit struct {
	Epoch int64 `json:"epoch"`
	Seq   int64 `json:"seq"`
	// Digest identifies the commit body, so a retry after a lost response is recognized.
	Digest string          `json:"digest"`
	Rows   []ChatCommitRow `json:"rows"`
	Title  string          `json:"title,omitempty"`
}

// ChatCommitResult is the response of POST /chats/{id}/commits.
type ChatCommitResult struct {
	Seq       int64     `json:"seq"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// RenameChatRequest is the body of PATCH /chats/{id}.
type RenameChatRequest struct {
	Title string `json:"title"`
}

// ChatShare is the response of POST /chats/{id}/share: a token that lets
// another user copy the chat with POST /shares/{token}/copy.
type ChatShare struct {
	Token string `json:"token"`
}
