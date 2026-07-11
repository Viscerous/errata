import { readFile } from 'node:fs/promises'

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

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.info('Architecture lint passed')
