/** Jolty's size: css px per model unit (the 132-unit figure stands 132 * px tall), and the factor over the original 0.6 */
export type MascotSize = 'small' | 'normal' | 'big'
const PX: Record<MascotSize, number> = { small: 0.6, normal: 0.75, big: 0.9 }
export const dim = { px: PX.big, k: PX.big / 0.6 }

export function setSize(size: MascotSize | undefined): void {
  dim.px = PX[size ?? 'big'] ?? PX.big
  dim.k = dim.px / 0.6
}
