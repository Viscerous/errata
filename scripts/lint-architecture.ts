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
