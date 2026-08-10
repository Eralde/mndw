const IGNORED_MNDW_BUTTON_WARNING_CODES = new Set([
  'a11y_click_events_have_key_events',
  'a11y_no_static_element_interactions',
]);

/**
 * Returns true for Svelte's false-positive interaction warnings on mndw-button.
 * The custom element delegates interaction to its native shadow-DOM button.
 *
 * @param {{code?: string; message?: string}} warning
 * @returns {boolean}
 */
function isMndwButtonA11yWarning(warning) {
  return IGNORED_MNDW_BUTTON_WARNING_CODES.has(warning.code ?? '')
    && (warning.message ?? '').includes('<mndw-button>');
}

module.exports = {isMndwButtonA11yWarning};
