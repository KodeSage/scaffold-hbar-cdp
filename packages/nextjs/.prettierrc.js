// No AST-rewriting plugins here: @trivago/prettier-plugin-sort-imports pins an old @babel/generator that
// cannot print the TypeScript AST from newer @babel/parser releases. Under npm (no lockfile pinning) it
// silently stripped generics (`Record<K, V>` -> `Record`) during the scaffold's format step.
module.exports = {
  arrowParens: "avoid",
  printWidth: 120,
  tabWidth: 2,
  trailingComma: "all",
};
