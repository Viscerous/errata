import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const violations: string[] = []

async function sourceFiles(root: string): Promise<string[]> {
  const glob = new Bun.Glob(`${root}/**/*.{ts,tsx}`)
  return Array.fromAsync(glob.scan({ cwd: process.cwd(), onlyFiles: true }))
}

for (const file of await sourceFiles('src/server')) {
  const source = await readFile(file, 'utf-8')
  if (/from ['"]@\/(components|hooks|routes|lib\/api)/.test(source)) {
    violations.push(`${file}: server code imports a UI or client-API module`)
  }
}

for (const file of await sourceFiles('src')) {
  if (file.endsWith('routeTree.gen.ts')) continue
  const source = await readFile(file, 'utf-8')
  source.split(/\r?\n/).forEach((line, index) => {
    if (/\bas any\b|@ts-ignore/.test(line)) {
      violations.push(`${file}:${index + 1}: unsafe TypeScript escape hatch`)
    }
  })
}

// Remote access serves the app over plain HTTP on a LAN address, which is not a
// secure context, so secure-context-only browser APIs are absent there and throw
// on the first call. `crypto.randomUUID()` in the generation path threw before the
// request was built, leaving the UI generating forever with nothing reaching the
// server — invisible on localhost, which is a secure context by definition.
// `crypto.subtle` (pack publishing) and un-chained `navigator.clipboard` (copy
// buttons) are the same class and still to be fixed; they are not enforced here
// yet because both need a real fallback rather than a swap.
const SECURE_CONTEXT_ONLY = [
  { pattern: /\bcrypto\s*\.\s*randomUUID\s*\(/, api: 'crypto.randomUUID()', instead: 'generateRunId/randomHex from @/lib/client-ids' },
]

/** Blanks out comments so prose about a banned API doesn't trip the rule. */
function stripComments(source: string): string[] {
  let inBlock = false
  return source.split(/\r?\n/).map((line) => {
    let out = ''
    for (let i = 0; i < line.length; i++) {
      if (inBlock) {
        if (line.startsWith('*/', i)) { inBlock = false; i++ }
        continue
      }
      if (line.startsWith('/*', i)) { inBlock = true; i++; continue }
      if (line.startsWith('//', i)) break
      out += line[i]
    }
    return out
  })
}

for (const file of await sourceFiles('src')) {
  // Server code never runs in a browser, so the restriction does not apply.
  if (/^src[/\\]server[/\\]/.test(file)) continue
  stripComments(await readFile(file, 'utf-8')).forEach((line, index) => {
    for (const { pattern, api, instead } of SECURE_CONTEXT_ONLY) {
      if (pattern.test(line)) {
        violations.push(
          `${file}:${index + 1}: ${api} is secure-context only and absent over LAN HTTP; use ${instead}`,
        )
      }
    }
  })
}

// A row that is itself a button cannot also carry a delete button: the browser
// unnests them, React's hydration disagrees, and the row stops being clickable.
// Put the row's chrome on a div and make the two buttons siblings.
const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'Button'])

type Interactive = { name: string; line: number }

function jsxName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText()
}

function isSlotted(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  // `asChild` renders no element of its own; the child becomes the control.
  const props = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes
  return props.properties.some((prop) => ts.isJsxAttribute(prop) && prop.name.getText() === 'asChild')
}

for (const file of await sourceFiles('src')) {
  if (!file.endsWith('.tsx')) continue
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )

  const walk = (node: ts.Node, enclosing: Interactive | null) => {
    let inner = enclosing
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && !isSlotted(node)) {
      const name = jsxName(node)
      if (INTERACTIVE.has(name)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (enclosing) {
          violations.push(
            `${file}:${line}: <${name}> nested inside <${enclosing.name}> from line ${enclosing.line}`,
          )
        }
        inner = { name, line }
      }
    }
    node.forEachChild((child) => walk(child, inner))
  }

  walk(source, null)
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.info('Architecture lint passed')
