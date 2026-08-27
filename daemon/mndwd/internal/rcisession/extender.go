package rcisession

// Unauthorized invalidates one live extender generation, or the captured
// controller epoch for the controller target.
func (s *Service) Unauthorized(identity string, generation uint64) {
	if identity == "controller" {
		s.InvalidateController(generation)
		return
	}
	manager := s.SessionManager()
	if manager == nil || !manager.HasMember(identity) {
		return
	}
	manager.Unauthorized(identity, generation)
}
