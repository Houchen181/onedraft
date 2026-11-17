// QR codes for logins that a phone app confirms (e.g. Bilibili): an SVG data URL the Connect window can show.

import qrcode from 'qrcode-generator'

export function qrDataUrl(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  // Black on white with a quiet zone of 4 modules (the margin is in pixels), whatever the app's theme: phone
  // scanners need the contrast and the white border.
  const svg = qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true })
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}
