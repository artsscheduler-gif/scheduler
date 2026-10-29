// Proves the anon key cannot read or write any table or call any function.
// Used by the Phase 1 test (local) and the pre-launch check (production).

export interface AnonCheckResult {
  tables: string[];
  functions: string[];
  failures: string[];
}

async function schemaObjects(url: string, serviceKey: string, schema: string) {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': schema },
  });
  if (!res.ok) throw new Error(`OpenAPI for ${schema}: ${res.status}`);
  const spec = (await res.json()) as { paths: Record<string, unknown> };
  const paths = Object.keys(spec.paths).filter((p) => p !== '/');
  return {
    tables: paths.filter((p) => !p.startsWith('/rpc/')).map((p) => p.slice(1)),
    functions: paths.filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5)),
  };
}

export async function anonCheck(url: string, anonKey: string, serviceKey: string, schemas = ['arts', 'public']): Promise<AnonCheckResult> {
  const out: AnonCheckResult = { tables: [], functions: [], failures: [] };
  const anon = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

  for (const schema of schemas) {
    const { tables, functions } = await schemaObjects(url, serviceKey, schema);
    for (const t of tables) {
      const name = `${schema}.${t}`;
      out.tables.push(name);
      const sel = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: { ...anon, 'Accept-Profile': schema } });
      const body = await sel.text();
      // A 200 with an empty array still means anon has a grant: fail it.
      if (sel.ok) out.failures.push(`${name}: anon SELECT allowed (${sel.status} ${body.slice(0, 80)})`);

      const ins = await fetch(`${url}/rest/v1/${t}`, {
        method: 'POST',
        headers: { ...anon, 'Content-Profile': schema, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({}),
      });
      if (ins.ok) out.failures.push(`${name}: anon INSERT allowed (${ins.status})`);
      else if (!/permission denied|42501|PGRST106|schema must be one of/i.test(await ins.text()))
        out.failures.push(`${name}: anon INSERT rejected for a reason other than permissions (${ins.status})`);

      const upd = await fetch(`${url}/rest/v1/${t}?id=not.is.null`, {
        method: 'PATCH',
        headers: { ...anon, 'Content-Profile': schema, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({}),
      });
      if (upd.ok) out.failures.push(`${name}: anon UPDATE allowed (${upd.status})`);

      const del = await fetch(`${url}/rest/v1/${t}?id=eq.00000000-0000-0000-0000-000000000000`, {
        method: 'DELETE',
        headers: { ...anon, 'Content-Profile': schema },
      });
      if (del.ok) out.failures.push(`${name}: anon DELETE allowed (${del.status})`);
    }
    for (const f of functions) {
      const name = `${schema}.${f}()`;
      out.functions.push(name);
      const r = await fetch(`${url}/rest/v1/rpc/${f}`, {
        method: 'POST',
        headers: { ...anon, 'Content-Profile': schema, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const text = await r.text();
      // Not-found-by-signature errors are fine only if the function is not executable by anon at all.
      if (r.ok || !/permission denied|42501|PGRST202|PGRST106/i.test(text))
        out.failures.push(`${name}: anon call not denied (${r.status} ${text.slice(0, 80)})`);
    }
  }
  return out;
}
