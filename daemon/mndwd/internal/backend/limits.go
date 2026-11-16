package backend

import "sync"

func DefaultLimits() Limits {
	return Limits{
		MaxConcurrentExecTotal:     8,
		MaxConcurrentExecPerPlugin: 4,
		MaxSupervisedServices:      8,
	}
}

type Admission struct {
	mu                sync.Mutex
	maxConcurrentExec int
	maxExecPerPlugin  int
	totalExec         int
	pluginExec        map[string]int
}

type Reservation struct {
	admission *Admission
	pluginID  string
	kind      reservationKind
	once      sync.Once
}

type reservationKind uint8

const reservationExec reservationKind = iota + 1

func NewAdmission(limits Limits) *Admission {
	return &Admission{
		maxConcurrentExec: limits.MaxConcurrentExecTotal,
		maxExecPerPlugin:  limits.MaxConcurrentExecPerPlugin,
		pluginExec:        make(map[string]int),
	}
}

func (a *Admission) TryAcquireExec(pluginID string) (*Reservation, bool) {
	a.mu.Lock()

	defer a.mu.Unlock()

	if a.totalExec >= a.maxConcurrentExec {
		return nil, false
	}

	if a.pluginExec[pluginID] >= a.maxExecPerPlugin {
		return nil, false
	}

	a.totalExec++
	a.pluginExec[pluginID]++

	return &Reservation{admission: a, pluginID: pluginID, kind: reservationExec}, true
}

func (r *Reservation) Release() {
	if r == nil || r.admission == nil {
		return
	}

	r.once.Do(func() {
		r.admission.mu.Lock()

		defer r.admission.mu.Unlock()

		r.admission.totalExec--
		r.admission.pluginExec[r.pluginID]--

		if r.admission.pluginExec[r.pluginID] == 0 {
			delete(r.admission.pluginExec, r.pluginID)
		}
	})
}

func (a *Admission) Snapshot() (execTotal int, perPlugin map[string]int) {
	a.mu.Lock()

	defer a.mu.Unlock()

	perPlugin = make(map[string]int, len(a.pluginExec))

	for pluginID, count := range a.pluginExec {
		perPlugin[pluginID] = count
	}

	return a.totalExec, perPlugin
}
