export function getStoryDisplayName(name: string | null | undefined): string {
  return name?.trim() || 'Untitled story'
}
