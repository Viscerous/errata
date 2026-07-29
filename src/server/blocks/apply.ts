import type { ContextBlock } from '../llm/context-builder'
import type { BlockConfig, CustomBlockDefinition } from './schema'

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/**
 * Evaluates a custom block definition into a ContextBlock.
 * Simple blocks use content as-is; script blocks execute the content as an
 * async function body so they can `await` helpers like `ctx.getFragment(id)`.
 */
async function evaluateCustomBlock(def: CustomBlockDefinition, scriptContext: object): Promise<ContextBlock | null> {
  if (def.type === 'simple') {
    return {
      id: def.id,
      name: def.name,
      role: def.role,
      content: def.content,
      order: def.order,
      source: 'custom',
    }
  }

  // Script block: execute content as an async function body with ctx parameter
  try {
    const fn = new AsyncFunction('ctx', def.content)
    const result = await fn(scriptContext)

    if (typeof result !== 'string' || result.trim() === '') return null

    return {
      id: def.id,
      name: def.name,
      role: def.role,
      content: result,
      order: def.order,
      source: 'custom',
    }
  } catch (err) {
    // Script errors produce an error block so users can see what went wrong
    const msg = err instanceof Error ? err.message : String(err)
    return {
      id: def.id,
      name: def.name,
      role: def.role,
      content: `[Script error in "${def.name}": ${msg}]`,
      order: def.order,
      source: 'custom',
    }
  }
}

/**
 * Applies block configuration to the default blocks:
 * 1. Evaluate + insert custom blocks
 * 2. Apply content overrides (override/prepend/append)
 * 3. Apply blockOrder ordering
 * 4. Apply individual order overrides
 * 5. Remove disabled blocks
 */
export async function applyBlockConfig(
  blocks: ContextBlock[],
  config: BlockConfig,
  scriptContext: object,
): Promise<ContextBlock[]> {
  let result = [...blocks]

  // 1. Evaluate and insert enabled custom blocks
  for (const def of config.customBlocks) {
    if (!def.enabled) continue
    // Check if override disables it
    const override = config.overrides[def.id]
    if (override?.enabled === false) continue

    const block = await evaluateCustomBlock(def, scriptContext)
    if (block) {
      result.push(block)
    }
  }

  // 2. Apply content overrides to existing blocks
  result = result.map(block => {
    const override = config.overrides[block.id]
    if (!override?.contentMode || !override.customContent) return block

    let content: string
    switch (override.contentMode) {
      case 'override':
        content = override.customContent
        break
      case 'prepend':
        content = override.customContent + '\n' + block.content
        break
      case 'append':
        content = block.content + '\n' + override.customContent
        break
      default:
        return block
    }

    // A full override no longer represents the structured fragment surface the
    // default block described. Drop its metadata so context receipts do not
    // claim that removed fragments were delivered.
    return override.contentMode === 'override'
      ? { ...block, content, fragmentContext: undefined }
      : { ...block, content }
  })

  // 3. Apply blockOrder ordering (position-based)
  if (config.blockOrder.length > 0) {
    const orderMap = new Map(config.blockOrder.map((id, i) => [id, i]))
    result = result.map(block => {
      const pos = orderMap.get(block.id)
      if (pos !== undefined) {
        return { ...block, order: pos }
      }
      return block
    })
  }

  // 4. Apply individual order overrides
  result = result.map(block => {
    const override = config.overrides[block.id]
    if (override?.order !== undefined) {
      return { ...block, order: override.order }
    }
    return block
  })

  // 5. Remove disabled blocks
  result = result.filter(block => {
    const override = config.overrides[block.id]
    if (override?.enabled === false) return false
    return true
  })

  return result
}
