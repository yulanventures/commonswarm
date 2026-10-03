/** Execute release catalog predicates through postgres.js, without psql commands. */
export function releaseCatalogQuery(source: string, alias: 'catalog_ok' | 'rollback_ok'): string {
  const diagnostics = new RegExp(String.raw`\n\\gset\n\\if :${alias}_checks_ok\n\\else\n\\warn [^\n]+\n\\endif\nSELECT :'${alias}_checks_ok'::boolean AS ${alias}\n\\gset\s*$`, 'u');
  let query: string;
  if (diagnostics.test(source)) {
    // Keep the original aggregate and every labelled predicate. Only the psql
    // variable round trip becomes a direct result column; failed labels remain.
    query = source.replace(diagnostics, '').replace(
      new RegExp(String.raw`\bAS ${alias}_checks_ok FROM checks$`, 'u'),
      `AS ${alias} FROM checks`,
    );
  } else {
    query = source.replace(/\n\\gset\s*$/u, '');
  }
  if (/^\s*\\/mu.test(query) || /:'(?:catalog_ok|rollback_ok)_checks_ok'/u.test(query)
    || !new RegExp(String.raw`\bAS ${alias}(?: FROM checks)?\s*$`, 'u').test(query)) {
    throw new Error('Unsupported catalog proof wrapper');
  }
  return `${query.trimEnd()};\n`;
}
