// Package rci builds RCI queries, sends them as one command array, and
// unwraps each result by its query path.
//
// Unlike the TypeScript RciManager.execute, this package applies no default
// timeout. The deadline comes entirely from the caller's context:
//
//	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
//	defer cancel()
package rci
