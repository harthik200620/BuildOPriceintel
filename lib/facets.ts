/**
 * Push the authored filter trees into `facet_definition`, which is what the
 * query layer actually reads.
 *
 * This lives here rather than inside scripts/init-db.ts because two different
 * commands have to do it and only one of them was. `filters/*.json` is the
 * source of truth for the panel, but the app never opens those files — it
 * reads the table. So `npm run reconcile` rewriting the JSON changed a
 * document and left the running rail on whatever `npm run db:init` last
 * seeded, which is how the published tree came to state one set of cement
 * price bands while the interface applied another.
 *
 * That gap is a compliance problem, not only an inconsistency:
 * CP(E-Commerce) Rule 5(3)(f) requires the ranking and filtering parameters
 * you disclose to be the ones you apply. Reconciliation now ends by calling
 * this, so the document and the rail cannot drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';

export const FILTER_FILES: Record<string, string> = {
  cement: 'cement.json',
  tmt_steel: 'tmt-steel.json',
  water_pipes: 'water-pipes.json',
  bricks_blocks: 'bricks-blocks.json',
};

export function seedFacets(root = process.cwd()): number {
  const stmt = db().prepare(
    `INSERT INTO facet_definition (category,facet_id,facet_key,label,type,control,cluster,visibility,
       sort_order,depends_on_facet,depends_on_value,default_open,default_state,why,note,
       needs_verification,values_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(category,facet_id) DO UPDATE SET
       label=excluded.label, values_json=excluded.values_json, sort_order=excluded.sort_order,
       visibility=excluded.visibility, why=excluded.why, note=excluded.note,
       needs_verification=excluded.needs_verification`,
  );
  let n = 0;
  for (const [category, fname] of Object.entries(FILTER_FILES)) {
    const spec = JSON.parse(fs.readFileSync(path.join(root, 'filters', fname), 'utf8'));
    for (const f of spec.filters) {
      const visibility = f.visibility ?? (f.depends_on ? 'conditional' : 'primary');
      stmt.run(
        category, f.id, f.facet_key ?? f.id, f.label, f.type ?? 'multi', f.control, f.cluster,
        visibility, f.sort_order ?? 999,
        f.depends_on?.filter ?? null, f.depends_on?.value ?? null,
        f.default_open === false ? 0 : 1, f.default_state ?? null,
        f.why ?? null, f.note ?? null, f.needs_verification ?? null,
        JSON.stringify(f.values),
      );
      n++;
    }
  }
  return n;
}
