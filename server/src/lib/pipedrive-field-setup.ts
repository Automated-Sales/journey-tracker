import {
  listPersonFields,
  listDealFields,
  createPersonField,
  createDealField,
  PipedriveFieldType,
} from "./pipedrive";
import { PERSON_FIELDS, DEAL_FIELDS, FieldDef } from "./pipedrive-fields";
import { db } from "../db";

/**
 * Shared by the CLI (`npm run setup:pipedrive`) and the self-serve portal
 * signup route — creates (or reuses, by name) the custom fields this app
 * writes attribution data into, on both Person and Deal, then saves the
 * name -> key map onto the tenant row. Extracted here so the two callers
 * can't drift: this used to live only in setup-pipedrive-fields.ts, but
 * self-serve signup needs to run the exact same logic automatically
 * rather than telling a new client to go run a CLI command by hand.
 */
async function ensureFields(
  token: string,
  defs: FieldDef[],
  existing: any[],
  create: (token: string, name: string, type: PipedriveFieldType) => Promise<{ key: string }>,
  log: (msg: string) => void
): Promise<Record<string, string>> {
  const byName = new Map(existing.map((f: any) => [f.name, f]));
  const map: Record<string, string> = {};

  for (const def of defs) {
    const found = byName.get(def.name);
    if (found) {
      log(`  already exists: "${def.name}" (key: ${found.key})`);
      map[def.localKey] = found.key;
      continue;
    }
    log(`  creating: "${def.name}" (${def.field_type})...`);
    const created = await create(token, def.name, def.field_type);
    log(`    -> key: ${created.key}`);
    map[def.localKey] = created.key;
  }

  return map;
}

export async function setupPipedriveFields(
  tenantId: string,
  token: string,
  log: (msg: string) => void = () => {}
): Promise<{ person: Record<string, string>; deal: Record<string, string> }> {
  log("Person fields:");
  const existingPersonFields = await listPersonFields(token);
  const personMap = await ensureFields(token, PERSON_FIELDS, existingPersonFields, createPersonField, log);

  log("Deal fields:");
  const existingDealFields = await listDealFields(token);
  const dealMap = await ensureFields(token, DEAL_FIELDS, existingDealFields, createDealField, log);

  await db.tenant.updateFieldMaps(tenantId, { person: personMap, deal: dealMap });

  return { person: personMap, deal: dealMap };
}
