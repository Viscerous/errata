import type { Fragment } from './schema'

export interface FragmentTypeDefinition {
  type: string
  prefix: string
  stickyByDefault: boolean
  contextRenderer: (fragment: Fragment) => string
  shortlistFields?: (keyof Fragment)[]
  /** Whether to generate type-specific LLM tools (get/list) for this type. Defaults to true. */
  llmTools?: boolean
  /**
   * Whether this type is hidden from the main fragment list by default.
   * Used for librarian-managed artifacts (summaries) that don't belong
   * in the writer's everyday fragment view. They still surface in their
   * own dedicated panels.
   */
  hiddenFromList?: boolean
}

export class FragmentTypeRegistry {
  private types = new Map<string, FragmentTypeDefinition>()
  private prefixes = new Map<string, FragmentTypeDefinition>()

  constructor() {
    this.registerBuiltins()
  }

  register(def: FragmentTypeDefinition): void {
    if (this.types.has(def.type)) {
      throw new Error(`Fragment type "${def.type}" is already registered`)
    }
    if (this.prefixes.has(def.prefix)) {
      throw new Error(`Prefix "${def.prefix}" is already in use`)
    }
    this.types.set(def.type, def)
    this.prefixes.set(def.prefix, def)
  }

  getType(type: string): FragmentTypeDefinition | undefined {
    return this.types.get(type)
  }

  getTypeByPrefix(prefix: string): FragmentTypeDefinition | undefined {
    return this.prefixes.get(prefix)
  }

  listTypes(): FragmentTypeDefinition[] {
    return [...this.types.values()]
  }

  unregister(type: string): void {
    const def = this.types.get(type)
    if (def) {
      this.prefixes.delete(def.prefix)
      this.types.delete(type)
    }
  }

  renderContext(fragment: Fragment): string {
    const def = this.types.get(fragment.type)
    if (!def) {
      return `[${fragment.type}:${fragment.id}] ${fragment.content}`
    }
    return def.contextRenderer(fragment)
  }

  private registerBuiltins(): void {
    this.register({
      type: 'prose',
      prefix: 'pr',
      stickyByDefault: false,
      contextRenderer: (f) => f.content,
      shortlistFields: ['id', 'type', 'description'],
      llmTools: false,
    })

    this.register({
      type: 'character',
      prefix: 'ch',
      stickyByDefault: false,
      // One level below the `## <Type>` section heading, like every fragment.
      contextRenderer: (f) =>
        `### ${f.name}\n${f.content}`,
      llmTools: false,
    })

    this.register({
      type: 'guideline',
      prefix: 'gl',
      stickyByDefault: true,
      // A `###` heading like every fragment: bold stays reserved for the rule
      // labels *inside* guideline bodies (house style: one bold = one rule), so
      // the name doesn't compete with them.
      contextRenderer: (f) =>
        `### ${f.name}\n${f.content}`,
      shortlistFields: ['id', 'name', 'description'],
      llmTools: false,
    })

    this.register({
      type: 'knowledge',
      prefix: 'kn',
      stickyByDefault: false,
      contextRenderer: (f) =>
        `### ${f.name}\n${f.content}`,
      shortlistFields: ['id', 'name', 'description'],
      llmTools: false,
    })

    this.register({
      type: 'image',
      prefix: 'im',
      stickyByDefault: false,
      contextRenderer: (f) =>
        `[image:${f.id}] ${f.name} - ${f.description}`,
      shortlistFields: ['id', 'name', 'description'],
      llmTools: false,
    })

    this.register({
      type: 'icon',
      prefix: 'ic',
      stickyByDefault: false,
      contextRenderer: (f) =>
        `[icon:${f.id}] ${f.name} - ${f.description}`,
      shortlistFields: ['id', 'name', 'description'],
      llmTools: false,
    })

    this.register({
      type: 'marker',
      prefix: 'mk',
      stickyByDefault: false,
      contextRenderer: () => '',
      llmTools: false,
    })

    this.register({
      type: 'summary',
      prefix: 'sm',
      stickyByDefault: false,
      contextRenderer: (f) => f.content,
      shortlistFields: ['id', 'name', 'description'],
      llmTools: false,
      hiddenFromList: true,
    })
  }
}

/** Singleton registry instance */
export const registry = new FragmentTypeRegistry()
