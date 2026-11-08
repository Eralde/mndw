// GENERATED from frontend/sdk/src/event-schema.ts — do not edit by hand.
package events

import "encoding/json"

type Source string

const (
	SourceHook     Source = "hook"
	SourceLog      Source = "log"
	SourceInternal Source = "internal"
)

type Topic string

const (
	TopicWanConnected              Topic = "wan.connected"
	TopicWanDisconnected           Topic = "wan.disconnected"
	TopicNetIPChanged              Topic = "net.ip_changed"
	TopicNetDhcpLease              Topic = "net.dhcp_lease"
	TopicNetDnsChanged             Topic = "net.dns_changed"
	TopicWifiClientJoin            Topic = "wifi.client_join"
	TopicWifiClientLeave           Topic = "wifi.client_leave"
	TopicFirewallRebuilt           Topic = "firewall.rebuilt"
	TopicUSBAttached               Topic = "usb.attached"
	TopicUSBDetached               Topic = "usb.detached"
	TopicFsMounted                 Topic = "fs.mounted"
	TopicFsUnmounted               Topic = "fs.unmounted"
	TopicClockSynced               Topic = "clock.synced"
	TopicScheduleFired             Topic = "schedule.fired"
	TopicButtonPressed             Topic = "button.pressed"
	TopicAuthLogin                 Topic = "auth.login"
	TopicFirmwareAvailable         Topic = "firmware.available"
	TopicPluginInstalled           Topic = "plugin.installed"
	TopicPluginRemoved             Topic = "plugin.removed"
	TopicPluginApproved            Topic = "plugin.approved"
	TopicPluginStarted             Topic = "plugin.started"
	TopicPluginStopped             Topic = "plugin.stopped"
	TopicDaemonStarted             Topic = "daemon.started"
	TopicDaemonStopping            Topic = "daemon.stopping"
	TopicDaemonUpdated             Topic = "daemon.updated"
	TopicStorageLow                Topic = "storage.low"
	TopicTelemetryGatheringChanged Topic = "telemetry.gathering_changed"
)

type Event struct {
	ID      string          `json:"id"`
	Ts      int64           `json:"ts"`
	Topic   Topic           `json:"topic"`
	Source  Source          `json:"source"`
	Payload json.RawMessage `json:"payload"`
}

type WanConnectedPayload struct {
	Interface string `json:"interface"`
	Address   string `json:"address"`
	Mask      string `json:"mask"`
	Gateway   string `json:"gateway"`
}

type WanDisconnectedPayload struct {
	Interface string `json:"interface"`
}

type NetIPChangedPayload struct {
	Address   string `json:"address"`
	Mask      string `json:"mask"`
	Link      string `json:"link"`
	Connected bool   `json:"connected"`
}

type NetDhcpLeasePayload struct {
	MAC      string `json:"mac"`
	IP       string `json:"ip"`
	Hostname string `json:"hostname"`
	Action   string `json:"action"`
}

type NetDnsChangedPayload struct {
	Resolvers []string `json:"resolvers"`
}

type WifiClientJoinPayload struct {
	MAC   string `json:"mac"`
	Band  string `json:"band"`
	SSID  string `json:"ssid"`
	Iface string `json:"iface"`
}

type WifiClientLeavePayload struct {
	MAC   string `json:"mac"`
	Band  string `json:"band"`
	SSID  string `json:"ssid"`
	Iface string `json:"iface"`
}

type FirewallRebuiltPayload struct {
	TableType string `json:"table_type"`
	Table     string `json:"table"`
}

type USBAttachedPayload struct {
	Device string `json:"device"`
	Model  string `json:"model"`
	Vendor string `json:"vendor"`
	Port   string `json:"port"`
}

type USBDetachedPayload struct {
	Device string `json:"device"`
	Port   string `json:"port"`
}

type FsMountedPayload struct {
	FsType    string `json:"fs_type"`
	Label     string `json:"label"`
	Directory string `json:"directory"`
}

type FsUnmountedPayload struct {
	Label     string `json:"label"`
	Directory string `json:"directory"`
}

type ClockSyncedPayload struct {
	OffsetMs *int64 `json:"offset_ms,omitempty"`
}

type ScheduleFiredPayload struct {
	Name    string `json:"name"`
	Action  string `json:"action"`
	Elapsed int64  `json:"elapsed"`
}

type ButtonPressedPayload struct {
	Button  string `json:"button"`
	Gesture string `json:"gesture"`
}

type AuthLoginPayload struct {
	User    string `json:"user"`
	IP      string `json:"ip"`
	Success bool   `json:"success"`
}

type FirmwareAvailablePayload struct {
	Version string `json:"version"`
}

type PluginInstalledPayload struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type PluginRemovedPayload struct {
	Name string `json:"name"`
}

type PluginApprovedPayload struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type PluginStartedPayload struct {
	Name string `json:"name"`
}

type PluginStoppedPayload struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type DaemonStartedPayload struct {
	Version  string `json:"version"`
	UptimeMs int64  `json:"uptime_ms"`
}

type DaemonStoppingPayload struct {
	Reason string `json:"reason"`
}

type DaemonUpdatedPayload struct {
	Version string `json:"version"`
}

type StorageLowPayload struct {
	Path           string `json:"path"`
	AvailableBytes int64  `json:"available_bytes"`
	ThresholdBytes int64  `json:"threshold_bytes"`
}

type TelemetryGatheringChangedPayload struct {
	Enabled bool `json:"enabled"`
}
