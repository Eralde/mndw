package rcisession

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"mndwd/internal/rcisession/minter"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/proxy"
)

func (s *Service) Unauthorized(identity string) {
	document, err := s.store.Snapshot()
	if err != nil {
		return
	}

	if identity == "controller" {
		if document.Controller == nil {
			return
		}

		record := *document.Controller
		record.Support = model.SupportInvalid

		if err := s.store.ReplaceController(record); err == nil && s.enumerator != nil {
			s.enumerator.Invalidate()
			s.logTokenInvalidated("controller")
			s.notifyMutation("controller-token-invalidated")
		}

		return
	}

	record, ok := document.Extenders[identity]

	if !ok {
		return
	}

	record.Key = ""
	record.Token = ""
	record.Support = model.SupportUnknown

	if err := s.store.UpsertExtender(identity, record); err == nil {
		s.logTokenInvalidated(identity)
		s.notifyMutation("extender-token-invalidated")
	}
}

func (s *Service) DeleteExtenders(ctx context.Context) error {
	document, err := s.store.Snapshot()
	if err != nil {
		return err
	}

	if len(document.Extenders) == 0 {
		if err := s.store.DeleteExtenders(); err != nil {
			return err
		}

		s.notifyMutation("extender-record-deleted")

		return nil
	}

	failures, hasRemoteRecords := s.removeInactiveLocalRecords(document)

	if !hasRemoteRecords {
		return errors.Join(failures...)
	}

	currentMembers := make(map[string]struct{})
	membersKnown := false

	if s.enumerator != nil {
		s.enumerator.Invalidate()

		members, err := s.enumerator.List(ctx)
		if err != nil {
			failures = append(failures, fmt.Errorf("%w: enumerate current members: %v", ErrExtenderTokenDeletion, err))

			return errors.Join(failures...)
		}

		for _, member := range members {
			currentMembers[member.Identity] = struct{}{}
		}

		membersKnown = true
	}

	failures = append(failures, s.revokeRemoteTokens(ctx, document, currentMembers, membersKnown)...)

	return errors.Join(failures...)
}

func (s *Service) removeInactiveLocalRecords(document model.Document) ([]error, bool) {
	var failures []error
	hasRemoteRecords := false

	for identity, record := range document.Extenders {
		if record.Token != "" {
			hasRemoteRecords = true

			continue
		}

		if err := s.store.DeleteExtender(identity); err != nil {
			failures = append(failures, fmt.Errorf("%w: %s: remove inactive local record: %v", ErrExtenderTokenDeletion, identity, err))

			continue
		}

		s.notifyMutation("extender-token-deleted")
	}

	return failures, hasRemoteRecords
}

func (s *Service) revokeRemoteTokens(ctx context.Context, document model.Document, currentMembers map[string]struct{}, membersKnown bool) []error {
	var failures []error

	for identity, record := range document.Extenders {
		if record.Token == "" {
			continue
		}

		if membersKnown {
			if _, ok := currentMembers[identity]; !ok {
				if err := s.store.DeleteExtender(identity); err != nil {
					failures = append(failures, fmt.Errorf("%w: %s: remove deleted local record: %v", ErrExtenderTokenDeletion, identity, err))

					continue
				}

				s.notifyMutation("extender-token-deleted")

				continue
			}
		}

		if record.Key == "" {
			failures = append(failures, fmt.Errorf("%w: %s: token ID is missing", ErrExtenderTokenDeletion, identity))

			continue
		}

		if s.proxy == nil {
			failures = append(failures, fmt.Errorf("%w: %s: proxy unavailable", ErrExtenderTokenDeletion, identity))

			continue
		}

		response, err := s.proxy.Do(ctx, proxy.Request{
			Target:     identity,
			Method:     http.MethodPost,
			Path:       "rci/",
			Body:       tokenDeleteRequestBody(record.Key),
			AllowWrite: true,
		})
		tokenAlreadyInvalid := errors.Is(err, proxy.ErrSessionInvalid)

		if tokenAlreadyInvalid {
			err = nil
		}

		if err != nil {
			failures = append(failures, fmt.Errorf("%w: %s: remote revoke: %v", ErrExtenderTokenDeletion, identity, err))

			continue
		}

		if !tokenAlreadyInvalid && (response.Status < http.StatusOK || response.Status >= http.StatusMultipleChoices) {
			failures = append(failures, fmt.Errorf("%w: %s: remote revoke returned HTTP %d", ErrExtenderTokenDeletion, identity, response.Status))

			continue
		}

		if err := s.store.DeleteExtender(identity); err != nil {
			failures = append(failures, fmt.Errorf("%w: %s: remove local record: %v", ErrExtenderTokenDeletion, identity, err))

			continue
		}

		s.notifyMutation("extender-token-deleted")
	}

	return failures
}

func tokenDeleteRequestBody(id string) []byte {
	body, _ := json.Marshal(map[string]any{
		"authentication": map[string]any{
			"token": map[string]any{
				"delete": map[string]string{"id": id},
			},
		},
	})

	return body
}

func (s *Service) DeleteExtender(identity string) error {
	if err := s.store.DeleteExtender(identity); err != nil {
		return err
	}

	s.notifyMutation("extender-record-deleted")

	return nil
}

func (s *Service) Provision(ctx context.Context, generator minter.Generator, credentials minter.Credentials) ([]minter.Outcome, error) {
	if s.enumerator == nil {
		return nil, fmt.Errorf("%w: enumeration unavailable", proxy.ErrTargetUnreachable)
	}

	members, err := s.enumerator.List(ctx)
	if err != nil {
		return nil, err
	}

	outcomes := minter.Provision(ctx, generator, members, credentials)
	successes := 0

	for index := range outcomes {
		outcome := &outcomes[index]

		if outcome.Err != nil {
			continue
		}

		record := outcome.Record
		record.Support = model.SupportSupported

		if err := s.store.UpsertExtender(outcome.Member.Identity, record); err != nil {
			outcome.Err = err
			outcome.Reason = minter.ReasonUnreachable

			continue
		}

		s.notifyMutation("extender-token-created")

		successes++
	}

	if successes == 0 && len(outcomes) > 0 {
		allPolicyRefusals := true

		for _, outcome := range outcomes {
			if !errors.Is(outcome.Err, minter.ErrPersistentTokenRequiresHTTPS) && !errors.Is(outcome.Err, minter.ErrMemberOffline) {
				allPolicyRefusals = false

				break
			}
		}

		if !allPolicyRefusals {
			return outcomes, fmt.Errorf("all extender provisioning attempts failed")
		}
	}

	return outcomes, nil
}
