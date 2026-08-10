import type { WritingPlugin } from '@viscerous/errata-plugin-sdk'

const plugin: WritingPlugin = {
  manifest: {
    name: 'color-picker',
    version: '1.0.0',
    description: 'Assign colors to fragments via color=#AABBCC tags',
    panel: {
      title: 'Colors',
      showInSidebar: true,
      icon: { type: 'lucide', name: 'Hash' },
    },
  },
}

export default plugin
