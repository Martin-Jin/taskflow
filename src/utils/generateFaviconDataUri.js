/**
 * Builds a favicon as a data: URI, so the browser tab icon can match
 * whatever accent color is actually active right now — something a plain
 * static SVG file (public/favicon.svg, still used before the app has
 * finished loading) can never do, since a static file has no way to read
 * the app's own live state.
 *
 * Drawn with the same shape as BrandMark.jsx's in-app logo: a rounded
 * square in the given background color, with a FIXED WHITE checkmark on
 * top. The checkmark is always white here too, matching BrandMark.jsx and
 * every shipped accent preset's own readability against it — see that
 * file's header comment for why it's fixed rather than tied to a
 * contrast-driven token.
 */
export function generateFaviconDataUri(bgColorHex) {
  const canvas = document.createElement('canvas');
  const size = 32;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const radius = 8;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(size - radius, 0);
  ctx.quadraticCurveTo(size, 0, size, radius);
  ctx.lineTo(size, size - radius);
  ctx.quadraticCurveTo(size, size, size - radius, size);
  ctx.lineTo(radius, size);
  ctx.quadraticCurveTo(0, size, 0, size - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fillStyle = bgColorHex;
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(26.7, 8);
  ctx.lineTo(12, 22.7);
  ctx.lineTo(5.3, 16);
  ctx.stroke();

  return canvas.toDataURL('image/png');
}

/**
 * Swaps every `<link rel="icon">` tag's href to the given data URI. Reuses
 * the existing link tag(s) already in index.html rather than creating a
 * new one, so there's only ever one favicon link in the document.
 */
export function applyFaviconDataUri(dataUri) {
  if (!dataUri) return;
  const links = document.querySelectorAll('link[rel="icon"]');
  links.forEach((link) => {
    link.setAttribute('href', dataUri);
    link.setAttribute('type', 'image/png');
  });
}
