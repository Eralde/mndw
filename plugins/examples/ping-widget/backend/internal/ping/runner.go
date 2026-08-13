package ping

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"time"

	"ping-widget/internal/model"
)

var pingTimePattern = regexp.MustCompile(`time=([0-9]+(?:\.[0-9]+)?)`)

func RunOnce(hostIP string, timeout time.Duration) model.Sample {
	now := time.Now().UTC().Format(time.RFC3339)
	if hostIP == "" {
		return model.Sample{Success: false, At: now}
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	command := exec.CommandContext(ctx, "ping", "-c", "1", "-W", "2", hostIP)
	output, err := command.CombinedOutput()
	if err != nil {
		return model.Sample{Success: false, At: now}
	}

	match := pingTimePattern.FindSubmatch(output)
	if len(match) < 2 {
		return model.Sample{Success: false, At: now}
	}

	latency, parseErr := strconv.ParseFloat(string(match[1]), 64)
	if parseErr != nil {
		return model.Sample{Success: false, At: now}
	}

	return model.Sample{
		Success:   true,
		LatencyMs: latency,
		At:        now,
	}
}
