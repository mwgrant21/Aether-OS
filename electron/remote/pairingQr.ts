import qrcode from 'qrcode-generator';

/** QR code for `text` as an inline, scalable SVG string. Pure and deterministic. */
export function renderQrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}
