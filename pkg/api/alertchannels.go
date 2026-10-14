package api

// AlertChannel is a chat channel the assistant host's bot can post alerts to.
type AlertChannel struct {
	ID string `json:"id"`
	// Name is Mattermost's team/channel or the Webex room title.
	Name  string `json:"name"`
	Title string `json:"title"`
}

// AlertChannelPlatform is a chat platform of the assistant host, its bot, and the bot's channels.
type AlertChannelPlatform struct {
	Platform string         `json:"platform"`
	Bot      string         `json:"bot"`
	Channels []AlertChannel `json:"channels"`
}

// AlertChannelsResponse is the response of GET /alert-channels.
type AlertChannelsResponse struct {
	// HostURL is the assistant host's URL that contact points send to.
	HostURL   string                 `json:"hostUrl"`
	Platforms []AlertChannelPlatform `json:"platforms"`
}

// AlertWebhookRequest is the body of POST /alert-channels/webhook.
type AlertWebhookRequest struct {
	Platform string `json:"platform"`
	// ChannelID is one of the platform's channels from GET /alert-channels.
	ChannelID string `json:"channelId"`
	// Investigate is auto, mention (default), or off.
	Investigate string `json:"investigate,omitempty"`
	// Screenshots defaults to true.
	Screenshots *bool `json:"screenshots,omitempty"`
	// Format is host (default) or grafana.
	Format string `json:"format,omitempty"`
}

// AlertWebhookHMAC is the HMAC signature of Grafana's webhook integration.
type AlertWebhookHMAC struct {
	Secret          string `json:"secret"`
	Header          string `json:"header"`
	TimestampHeader string `json:"timestampHeader"`
}

// AlertWebhookSettings are the settings of a Grafana webhook integration that
// sends a contact point's notifications to an alert channel.
type AlertWebhookSettings struct {
	URL        string           `json:"url"`
	HTTPMethod string           `json:"httpMethod"`
	HMACConfig AlertWebhookHMAC `json:"hmacConfig"`
}
