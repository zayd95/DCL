// Pièces jointes de l'Assistant : photos, PDF, Excel/CSV, préparés dans le téléphone avant l'envoi.
// Gemini lit directement les images et les PDF (texte, tableaux, écriture manuscrite).

export type Attachment = {
  name: string;
  mime: string;
  data: string; // base64, sans préfixe
  kind: 'image' | 'pdf' | 'table' | 'text';
  preview?: string; // miniature (dataURL) pour les images
  size: number; // octets envoyés
};

const MAX_PDF = 12 * 1024 * 1024;
export const MAX_TOTAL = 16 * 1024 * 1024;

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const textToBase64 = (t: string) => toBase64(new TextEncoder().encode(t).buffer as ArrayBuffer);

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function draw(img: HTMLImageElement, max: number, quality: number): string {
  const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * r);
  c.height = Math.round(img.naturalHeight * r);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

export async function prepareFile(file: File): Promise<Attachment> {
  const name = file.name || 'Photo';
  const lower = name.toLowerCase();

  if (file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/.test(lower)) {
    // 2000 px suffisent pour lire une facture ; le fichier pèse ~300-600 Ko au lieu de 4-8 Mo
    const img = await loadImage(file);
    const full = draw(img, 2000, 0.85);
    const data = full.split(',')[1];
    return { name, mime: 'image/jpeg', data, kind: 'image', preview: draw(img, 160, 0.7), size: data.length };
  }

  if (file.type === 'application/pdf' || lower.endsWith('.pdf')) {
    if (file.size > MAX_PDF) throw new Error(`${name} : PDF trop lourd (max 12 Mo).`);
    const data = toBase64(await file.arrayBuffer());
    return { name, mime: 'application/pdf', data, kind: 'pdf', size: data.length };
  }

  if (/\.(xlsx|xlsm|xls|ods)$/.test(lower)) {
    // Excel → texte CSV, feuille par feuille (bibliothèque chargée seulement quand il le faut)
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const text = wb.SheetNames.map((s) => `### Feuille « ${s} »\n${XLSX.utils.sheet_to_csv(wb.Sheets[s], { blankrows: false })}`)
      .join('\n\n').slice(0, 400_000);
    const data = textToBase64(text);
    return { name, mime: 'text/plain', data, kind: 'table', size: data.length };
  }

  if (file.type.startsWith('text/') || /\.(csv|txt|tsv|json)$/.test(lower)) {
    const data = textToBase64((await file.text()).slice(0, 400_000));
    return { name, mime: 'text/plain', data, kind: lower.endsWith('.txt') ? 'text' : 'table', size: data.length };
  }

  throw new Error(`${name} : format non pris en charge (photo, PDF, Excel ou CSV).`);
}
