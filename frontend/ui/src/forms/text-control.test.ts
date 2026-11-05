// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import {
  CommitTracker,
  accessibleTextFrom,
  forwardedLabel,
  idRefsTextFrom,
  labelTextFrom,
  normalizeText,
  setOrRemove,
} from './text-control.js';

describe('text-family resolvers', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeText('  Host \n  name  ')).toBe('Host name');
    expect(normalizeText(null)).toBe('');
  });

  it('joins every label in DOM order and skips empty ones', () => {
    document.body.innerHTML = '<label>  Host </label><label></label><label>name</label>';

    expect(labelTextFrom([...document.querySelectorAll('label')])).toBe('Host name');
  });

  it('drops aria-hidden subtrees but keeps content hidden only by CSS', () => {
    document.body.innerHTML = '<label id="marked">Router name<span aria-hidden="true"> *</span></label>'
      + '<label id="styled">Port<span hidden> number</span></label>';

    const marked = document.getElementById('marked');
    const styled = document.getElementById('styled');

    if (!marked || !styled) {
      throw new Error('missing labels');
    }

    expect(accessibleTextFrom(marked)).toBe('Router name');
    expect(accessibleTextFrom(styled)).toBe('Port number');
    expect(labelTextFrom([marked])).toBe('Router name');
  });

  it('drops aria-hidden subtrees from idref targets too', () => {
    document.body.innerHTML = '<span id="named">Listen port<span aria-hidden="true"> *</span></span>';

    expect(idRefsTextFrom(document, 'named')).toBe('Listen port');
  });

  it('resolves idref text and skips missing ids', () => {
    document.body.innerHTML = '<span id="a">First</span><span id="b">  Second  </span>';

    expect(idRefsTextFrom(document, 'a missing b')).toBe('First Second');
    expect(idRefsTextFrom(document, null)).toBe('');
  });

  it('appends the description to the name only where aria-description is unsupported', () => {
    expect(forwardedLabel('Host', 'Shown once', true)).toBe('Host');
    expect(forwardedLabel('Host', 'Shown once', false)).toBe('Host Shown once');
    expect(forwardedLabel('Host', '', false)).toBe('Host');
  });
});

describe('setOrRemove', () => {
  it('writes a value and deletes the attribute for an empty one', () => {
    const target = document.createElement('input');

    setOrRemove(target, 'aria-label', 'Host');

    expect(target.getAttribute('aria-label')).toBe('Host');

    setOrRemove(target, 'aria-label', '');

    expect(target.hasAttribute('aria-label')).toBe(false);
  });
});

describe('CommitTracker', () => {
  it('commits only a value that differs from the focus baseline', () => {
    const commits = vi.fn();
    const tracker = new CommitTracker(commits);

    tracker.commit('untouched');

    expect(commits).not.toHaveBeenCalled();

    tracker.captureBaseline('');
    tracker.commit('');

    expect(commits).not.toHaveBeenCalled();

    tracker.commit('typed');

    expect(commits).toHaveBeenCalledExactlyOnceWith('typed');
  });

  it('does not commit the same edit twice', () => {
    const commits = vi.fn();
    const tracker = new CommitTracker(commits);

    tracker.captureBaseline('');
    tracker.commit('typed');
    tracker.commit('typed');

    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('rebases on a programmatic write but not on a user write', () => {
    const commits = vi.fn();
    const tracker = new CommitTracker(commits);

    tracker.captureBaseline('');
    tracker.syncValue('from-binding');
    tracker.commit('from-binding');

    expect(commits).not.toHaveBeenCalled();

    tracker.markUserInput();
    tracker.syncValue('from-binding!');
    tracker.commit('from-binding!');

    expect(commits).toHaveBeenCalledExactlyOnceWith('from-binding!');
  });

  it('stops tracking once the baseline is released', () => {
    const commits = vi.fn();
    const tracker = new CommitTracker(commits);

    tracker.captureBaseline('');
    tracker.releaseBaseline();
    tracker.commit('typed');

    expect(commits).not.toHaveBeenCalled();
  });
});
