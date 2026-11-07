export const MNDW_BUTTON_A11Y_WARNING_CODES: ReadonlySet<string> = new Set([
  'a11y_click_events_have_key_events',
  'a11y_no_static_element_interactions',
]);

/** Returns true for Svelte's false-positive interaction warnings on mndw-button. */
export const isMndwButtonA11yWarning = (warning: {code?: string; message?: string}): boolean => {
  return MNDW_BUTTON_A11Y_WARNING_CODES.has(warning.code ?? '')
    && (warning.message ?? '').includes('<mndw-button>');
};
