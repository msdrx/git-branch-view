/** Human-facing label for a git ref while preserving non-ref inputs as-is. */
export function displayRefName(ref: string | null | undefined): string {
  if (!ref) {
    return '';
  }
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
}
