// One-off OpenAPI sanity check (references resolve, paths parse, no duplicate keys).
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const doc = parse(readFileSync('docs/openapi.yaml', 'utf8'))
const errors = []
if (!doc.openapi) errors.push('no openapi version')
if (!doc.paths) errors.push('no paths')
const refs = []
const collect = (node, path) => {
  if (node === null || typeof node !== 'object') return
  if (typeof node.$ref === 'string') refs.push({ ref: node.$ref, path })
  for (const [key, value] of Object.entries(node)) collect(value, `${path}.${key}`)
}
collect(doc, '$')
for (const { ref, path } of refs) {
  if (!ref.startsWith('#/')) { errors.push(`${path}: non-local ref ${ref}`); continue }
  const target = ref.slice(2).split('/').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), doc)
  if (target === undefined) errors.push(`${path}: dangling ${ref}`)
}
console.log('paths:', Object.keys(doc.paths).join(', '))
console.log('components:', Object.keys(doc.components ?? {}).join(', '))
console.log('refs checked:', refs.length)
console.log('errors:', errors.length === 0 ? 'none' : errors.join('; '))
process.exit(errors.length === 0 ? 0 : 1)
