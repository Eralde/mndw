module.exports = {
  'extends': [
    'stylelint-config-standard',
    'stylelint-config-hudochenkov/order',
  ],
  'plugins': [
    'stylelint-order',
  ],
  'rules': {
    'media-feature-range-notation': 'prefix',
    'keyframes-name-pattern': null,
    'no-empty-source': null,
    'selector-max-type': null,
    'selector-class-pattern': null,
    'no-descending-specificity': null,
    'block-no-redundant-nested-style-rules': null,
    'color-hex-length': null,
  },
}
