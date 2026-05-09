/**
 * Pallio UI helper — `cn` merges Tailwind class names safely.
 *
 * shadcn/ui depends on this exact export shape (`cn` from `@/lib/utils`).
 * Do not rename or change the signature without auditing every shadcn
 * component import in `components/ui/`.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
