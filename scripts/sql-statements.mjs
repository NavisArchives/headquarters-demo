// Splits a migration file into statements for D1's prepare(), one at a time.
// A plain split on ';' cuts a trigger in half: its body is `BEGIN …; END`,
// and a CASE inside it has an END of its own. A chunk stays open until every
// BEGIN and CASE in it has met its END. Dev-time only (tests, smoke checks).
export function sqlStatements(sql) {
  const statements = [];
  let open = '';
  for (const part of sql.replace(/--[^\n]*/g, '').split(';')) {
    open = open ? `${open};${part}` : part;
    const opens = (open.match(/\b(BEGIN|CASE)\b/gi) ?? []).length;
    const ends = (open.match(/\bEND\b/gi) ?? []).length;
    if (opens > ends) continue;
    if (open.trim()) statements.push(open.trim());
    open = '';
  }
  if (open.trim()) statements.push(open.trim());
  return statements;
}
