package dispatch

import "sync"

// pluginSems holds a per-plugin execution semaphore. Each plugin gets its own
// buffered channel of `limit` slots; acquire is non-blocking so an over-limit
// request is rejected immediately rather than queued behind a slow plugin.
type pluginSems struct {
	limit int
	mu    sync.Mutex
	sems  map[string]chan struct{}
}

func newPluginSems(limit int) *pluginSems {
	return &pluginSems{limit: limit, sems: map[string]chan struct{}{}}
}

// acquire tries to take a slot for plugin. It returns a release func and true on
// success, or a no-op func and false when the plugin is already at its limit.
func (p *pluginSems) acquire(plugin string) (release func(), admitted bool) {
	sem := p.semFor(plugin)

	select {
	case sem <- struct{}{}:
		return func() { <-sem }, true
	default:
		return func() {}, false
	}
}

func (p *pluginSems) semFor(plugin string) chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()

	sem, ok := p.sems[plugin]
	if !ok {
		sem = make(chan struct{}, p.limit)
		p.sems[plugin] = sem
	}

	return sem
}
