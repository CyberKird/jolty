interface QRCode {
  addData(data: string): void
  make(): void
  getModuleCount(): number
  isDark(row: number, col: number): boolean
}
declare function qrcode(typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'): QRCode
export default qrcode
