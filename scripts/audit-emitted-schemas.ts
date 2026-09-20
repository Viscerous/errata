import { z } from 'zod'
import {
  reportObservationInputSchema,
  reportContinuityInputSchema,
  reportDirectionsInputSchema,
  reportMaintenanceInputSchema,
  reportAnalysisInputSchema,
  librarianRecordCorrectionsInputSchema,
  librarianNewRecordsInputSchema,
} from '../src/server/librarian/analysis-tools'
import { proposeFragmentChangesSchema } from '../src/contracts/fragment-changes'

function walk(node: any, path: string, problems: string[]) {
  if (node === true || node === false || node == null) return
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, `${path}[${i}]`, problems))
    return
  }
  if (typeof node !== 'object') return
  if (node.type === 'object') {
    const ap = node.additionalProperties
    const isSchemaAp = ap && typeof ap === 'object'
    if (isSchemaAp && node.maxProperties === undefined && Object.keys(node.properties ?? {}).length === 0) {
      problems.push(`UNBOUNDED RECORD at ${path} (additionalProperties=schema, no maxProperties, no named properties)`)
    } else if (isSchemaAp && node.maxProperties === undefined && Object.keys(node.properties ?? {}).length > 0) {
      problems.push(`OPEN RECORD (additionalProperties=schema, no maxProperties) at ${path} — keys can still be added`)
    }
  }
  if (node.type === 'array' && node.maxItems === undefined) {
    problems.push(`UNBOUNDED ARRAY at ${path}`)
  }
  if (node.type === 'string' && node.maxLength === undefined) {
    // An enum or const is a closed value — bounded in the grammar even without maxLength.
    if ((Array.isArray(node.enum) && node.enum.length > 0) || node.const !== undefined) return
    problems.push(`UNBOUNDED STRING at ${path}`)
  }
  for (const [k, v] of Object.entries(node)) {
    if (['$schema', 'title', 'description', 'enum', 'const'].includes(k)) continue
    walk(v, `${path}.${k}`, problems)
  }
}

for (const [name, schema] of [
  ['reportObservation', reportObservationInputSchema],
  ['reportAnalysis', reportAnalysisInputSchema],
  ['reportContinuity', reportContinuityInputSchema],
  ['reportMaintenance', reportMaintenanceInputSchema],
  ['reportDirections', reportDirectionsInputSchema],
  ['proposeRecordCorrections', librarianRecordCorrectionsInputSchema],
  ['proposeNewRecords', librarianNewRecordsInputSchema],
  ['proposeFragmentChanges', proposeFragmentChangesSchema],
] as const) {
  const doc = z.toJSONSchema(schema as any)
  const problems: string[] = []
  walk(doc, name, problems)
  console.log(`=== ${name} ===`)
  if (problems.length === 0) {
    console.log('  no unbounded constructs')
  } else {
    for (const p of problems) console.log('  ' + p)
  }
}

const cont = z.toJSONSchema(reportContinuityInputSchema as any) as any
console.log('\nstate node (characters.items.properties.state):')
console.log(JSON.stringify(cont.properties.characters.items.properties.state, null, 1))
