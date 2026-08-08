package backend

import "sync"

type Admission struct {
	mu            sync.Mutex
	limits        Limits
	totalExec     int
	pluginExec    map[string]int
	services      int
	serviceOwners map[string]bool
}

type Reservation struct {
	admission *Admission
	pluginID  string
	kind      reservationKind
	owner     bool
	once      sync.Once
}

type reservationKind uint8

const (
	reservationExec reservationKind = iota + 1
	reservationService
)

func NewAdmission(limits Limits) *Admission {
	return &Admission{
		limits:        limits,
		pluginExec:    make(map[string]int),
		serviceOwners: make(map[string]bool),
	}
}

func (a *Admission) TryAcquireExec(pluginID string) (*Reservation, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.totalExec >= a.limits.MaxConcurrentExecTotal {
		return nil, false
	}
	if a.pluginExec[pluginID] >= a.limits.MaxConcurrentExecPerPlugin {
		return nil, false
	}
	a.totalExec++
	a.pluginExec[pluginID]++

	return &Reservation{admission: a, pluginID: pluginID, kind: reservationExec}, true
}

func (a *Admission) TryReserveService(pluginID string) (*Reservation, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.serviceOwners[pluginID] {
		return &Reservation{admission: a, pluginID: pluginID, kind: reservationService}, true
	}
	if a.services >= a.limits.MaxSupervisedServices {
		return nil, false
	}
	a.services++
	a.serviceOwners[pluginID] = true

	return &Reservation{admission: a, pluginID: pluginID, kind: reservationService, owner: true}, true
}

func (r *Reservation) Release() {
	if r == nil || r.admission == nil {
		return
	}
	r.once.Do(func() {
		if r.kind == reservationService && !r.owner {
			return
		}
		r.admission.mu.Lock()
		defer r.admission.mu.Unlock()
		switch r.kind {
		case reservationExec:
			r.admission.totalExec--
			r.admission.pluginExec[r.pluginID]--
			if r.admission.pluginExec[r.pluginID] == 0 {
				delete(r.admission.pluginExec, r.pluginID)
			}
		case reservationService:
			if r.admission.serviceOwners[r.pluginID] {
				delete(r.admission.serviceOwners, r.pluginID)
				r.admission.services--
			}
		}
	})
}

func (a *Admission) Snapshot() (execTotal, services int, perPlugin map[string]int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	perPlugin = make(map[string]int, len(a.pluginExec))
	for pluginID, count := range a.pluginExec {
		perPlugin[pluginID] = count
	}

	return a.totalExec, a.services, perPlugin
}
