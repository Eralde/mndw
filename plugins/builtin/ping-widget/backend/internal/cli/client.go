package cli

import (
	"encoding/json"
	"io"

	"ping-widget/internal/daemon"
	"ping-widget/internal/model"
)

func Send(request model.Request) (model.Response, error) {
	return daemon.DialSocket(request)
}

func ParseHostUpdate(reader io.Reader) (model.HostUpdateInput, error) {
	input := model.HostUpdateInput{}
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(&input); err != nil {
		return model.HostUpdateInput{}, err
	}
	return input, nil
}
