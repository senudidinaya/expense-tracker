type ClassValue = string | false | null | undefined;

/**
 * Joins class names, dropping falsy branches.
 *
 * Deliberately not `clsx`, and deliberately not `tailwind-merge`: a primitive
 * builds its own classes from one variant map, so there is nothing to
 * de-conflict internally. The `className` prop is for *additive* styling —
 * layout, width, margin at the call site. It cannot reliably override a
 * primitive's own colour or padding, because conflicting Tailwind utilities
 * resolve by stylesheet order, not by attribute order. If a call site needs a
 * different look, that is a new variant on the primitive.
 */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
