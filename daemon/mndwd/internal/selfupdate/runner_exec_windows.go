package selfupdate

import (
	"errors"
	"os"
)

func startDetached(_ string, _ []string, _ *os.File) error {
	return errors.ErrUnsupported
}
