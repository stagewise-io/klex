export default {
  '*': 'biome check --write --no-errors-on-unmatched',
  '*.rs': 'rustfmt --edition 2024',
};
