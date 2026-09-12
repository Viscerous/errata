import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// These are font-size utilities, not text colors. Without this extension the
// merge step drops them whenever a component also sets its foreground color.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': ['text-ui-label', 'text-ui-caption', 'text-ui-body'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
