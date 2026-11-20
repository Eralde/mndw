package opkg

import (
	"context"
	"fmt"
)

func (m *execManager) Install(ctx context.Context, packages []string) error {
	return m.mutate(ctx, "install", packages, "install")
}

func (m *execManager) Remove(ctx context.Context, packages []string) error {
	if err := rejectProtected(packages); err != nil {
		return err
	}

	out, err := m.mutateOutput(ctx, "remove", packages, "remove")

	// opkg refuses to remove a package other installed packages depend on, printing a
	// "depended upon by packages" warning. Depending on the device's opkg build this
	// comes with a zero exit (removing nothing) or a non-zero exit; either way the
	// generic exit-code error is unhelpful, so detect the warning in the output first
	// and surface a typed, actionable error regardless of the exit code.
	if conflict := detectDependents(out); conflict != nil {
		m.logger.Error("opkg remove refused: reverse dependencies",
			"packages", packages, "output", tailOutput(out))

		return conflict
	}

	return err
}

func (m *execManager) Upgrade(ctx context.Context, packages []string) error {
	if err := rejectProtected(packages); err != nil {
		return err
	}

	return m.mutate(ctx, "upgrade", packages, "upgrade")
}

func (m *execManager) Update(ctx context.Context) error {
	m.defaults()

	lease, err := m.acquireMutation(ctx, true)
	if err != nil {
		return fmt.Errorf("opkg update: %w", err)
	}

	defer lease.Abort()

	out, exitCode, err := m.run(ctx, "opkg", "update")
	if err != nil {
		m.logger.Error("opkg update failed", "output", tailOutput(out))

		return fmt.Errorf("opkg update: %w", err)
	}

	if exitCode != 0 {
		m.logger.Error("opkg update failed", "output", tailOutput(out), "exitCode", exitCode)

		return fmt.Errorf("opkg update exited %d", exitCode)
	}

	return nil
}

func rejectProtected(packages []string) error {
	for _, name := range packages {
		if name == "mndw" {
			return &ProtectedPackageError{Name: name}
		}
	}

	return nil
}
