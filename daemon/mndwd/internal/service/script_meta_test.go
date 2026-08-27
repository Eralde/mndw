package service

import (
	"strings"
	"testing"
)

func TestParseScriptMetaExtractsDeclaredFields(t *testing.T) {
	script := "#!/bin/sh\n" +
		"ENABLED=yes\n" +
		"PROCS=transmission-daemon\n" +
		"PID_FILE=\"/opt/var/run/mndwd.pid\"\n" +
		"start() { :; }\n"
	meta := parseScriptMeta(strings.NewReader(script))

	if meta.enabled == nil || !*meta.enabled {
		t.Fatalf("enabled = %v, want true", meta.enabled)
	}

	if meta.procs != "transmission-daemon" {
		t.Errorf("procs = %q, want transmission-daemon", meta.procs)
	}

	if meta.pidFile != "/opt/var/run/mndwd.pid" {
		t.Errorf("pidFile = %q, want /opt/var/run/mndwd.pid", meta.pidFile)
	}
}

func TestParseScriptMetaExtractsProcessIdentityFields(t *testing.T) {
	meta := parseScriptMeta(strings.NewReader(
		"NAME=cron\n" +
			"DAEMON=\"/opt/sbin/ntpd --foreground\"\n" +
			"SCRIPT=/opt/etc/init.d/S77ntpd extra\n" +
			"PROCS=ntpd worker\n",
	))

	if meta.name != "cron" {
		t.Errorf("name = %q, want cron", meta.name)
	}

	if meta.daemon != "/opt/sbin/ntpd" {
		t.Errorf("daemon = %q, want /opt/sbin/ntpd (first token)", meta.daemon)
	}

	if meta.script != "/opt/etc/init.d/S77ntpd" {
		t.Errorf("script = %q, want /opt/etc/init.d/S77ntpd", meta.script)
	}
}

func TestParseScriptMetaProcessFieldsIgnoreDynamicEmptyAndMalformedValues(t *testing.T) {
	meta := parseScriptMeta(strings.NewReader(
		"NAME=$SERVICE_NAME\n" +
			"DAEMON=`which daemon`\n" +
			"SCRIPT=\n" +
			"NAME=\n" +
			"DAEMON=not\tvalid\n" +
			"SCRIPT='unterminated\n" +
			"NOT A KEY=value\n",
	))

	if meta.name != "" || meta.daemon != "not" || meta.script != "unterminated" {
		t.Fatalf("metadata = %+v, want dynamic values ignored and static first tokens retained", meta)
	}
}

func TestParseScriptMetaProcessFieldsFirstWins(t *testing.T) {
	meta := parseScriptMeta(strings.NewReader(
		"NAME=first\n" +
			"NAME=second\n" +
			"DAEMON=first-daemon\n" +
			"DAEMON=second-daemon\n" +
			"SCRIPT=/first/script\n" +
			"SCRIPT=/second/script\n",
	))

	if meta.name != "first" || meta.daemon != "first-daemon" || meta.script != "/first/script" {
		t.Fatalf("metadata = %+v, want first static declaration for each field", meta)
	}
}

func TestParseScriptMetaEnabledFalsey(t *testing.T) {
	for _, value := range []string{"no", "1", "true", "on"} {
		meta := parseScriptMeta(strings.NewReader("ENABLED='" + value + "'\n"))

		if meta.enabled == nil || *meta.enabled {
			t.Errorf("ENABLED=%q: enabled = %v, want false", value, meta.enabled)
		}
	}
}

func TestParseScriptMetaAbsentEnabledIsNil(t *testing.T) {
	meta := parseScriptMeta(strings.NewReader("#!/bin/sh\nPROCS=foo\n"))

	if meta.enabled != nil {
		t.Fatalf("enabled = %v, want nil", meta.enabled)
	}
}

func TestParseScriptMetaEmptyEnabledIsExplicitFalse(t *testing.T) {
	// rc.func treats ENABLED= as not "yes", i.e. disabled. It must resolve to
	// an explicit false, not nil, so the S/K prefix does not re-enable it.
	for _, line := range []string{"ENABLED=\n", "ENABLED=\"\"\n"} {
		meta := parseScriptMeta(strings.NewReader(line))

		if meta.enabled == nil || *meta.enabled {
			t.Errorf("%q: enabled = %v, want explicit false", line, meta.enabled)
		}
	}
}

func TestParseScriptMetaUnresolvableEnabledIsNil(t *testing.T) {
	meta := parseScriptMeta(strings.NewReader("ENABLED=$RUN_AT_BOOT\n"))

	if meta.enabled != nil {
		t.Fatalf("enabled = %v, want nil (unresolvable falls back to prefix)", meta.enabled)
	}
}

func TestParseScriptMetaProcsNarrowsMultiValue(t *testing.T) {
	meta := parseScriptMeta(strings.NewReader("PROCS=\"transmission-daemon watchdog\"\n"))

	if meta.procs != "transmission-daemon" {
		t.Errorf("procs = %q, want transmission-daemon (first token only)", meta.procs)
	}
}

func TestParseScriptMetaRejectsShellExpansion(t *testing.T) {
	meta := parseScriptMeta(strings.NewReader("PID_FILE=\"$DATA_DIR/x.pid\"\nPROCS=`which foo`\n"))

	if meta.pidFile != "" {
		t.Errorf("pidFile = %q, want empty (unresolvable)", meta.pidFile)
	}

	if meta.procs != "" {
		t.Errorf("procs = %q, want empty (unresolvable)", meta.procs)
	}
}

func TestParseScriptMetaIgnoresUnrelatedAndFirstWins(t *testing.T) {
	script := "DAEMON=/opt/sbin/mndwd\nPROCS=first\nPROCS=second\n"
	meta := parseScriptMeta(strings.NewReader(script))

	if meta.procs != "first" {
		t.Errorf("procs = %q, want first", meta.procs)
	}

	if meta.pidFile != "" {
		t.Errorf("pidFile = %q, want empty", meta.pidFile)
	}
}

func TestParseScriptMetaHonorsScanLimit(t *testing.T) {
	padding := strings.Repeat("# filler comment line\n", 600) // > 8192 bytes
	meta := parseScriptMeta(strings.NewReader(padding + "ENABLED=yes\n"))

	if meta.enabled != nil {
		t.Fatalf("enabled = %v, want nil (line past scan limit)", meta.enabled)
	}
}
