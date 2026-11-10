import { useMemo } from 'react'
import qrcode from '../vendor/qrcode'

/** A QR code drawn as one SVG path: dark squares on a white quiet zone, so any phone camera reads it on any theme. */
export function QrCode({ text, size = 180 }: { text: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const count = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
    return { path: d, n: count + 8 }
  }, [text])
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" role="img" aria-label="QR code">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
