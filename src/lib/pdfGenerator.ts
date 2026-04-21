
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

export async function generatePDF(elementId: string, filename: string) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: '#ffffff'
  });

  const imgData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const imgProps = pdf.getImageProperties(imgData);
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

  pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
  pdf.save(filename);
}

export function generateBDSPrintTemplate(item: any, client: string, qte: number, ref: string) {
  // Simple structure for the printing/canvas capture
  return `
    <div id="bon-print-container" style="padding: 40px; font-family: sans-serif; color: #000; background: #fff; width: 800px;">
      <div style="border-bottom: 2px solid #1A237E; padding-bottom: 20px; margin-bottom: 20px; display: flex; justify-content: space-between;">
        <div>
          <h1 style="color: #1A237E; margin: 0;">DEPOTEK</h1>
          <p style="margin: 5px 0; font-size: 12px; opacity: 0.7;">Hub Logistique DEPOTEK, Sénégal</p>
        </div>
        <div style="text-align: right;">
          <h2 style="margin: 0;">BON DE SORTIE</h2>
          <p style="font-weight: bold; color: #1A237E;">Ref: ${ref}</p>
        </div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-bottom: 40px;">
        <div>
          <h4 style="text-transform: uppercase; font-size: 10px; color: #666;">Détails Client</h4>
          <p style="font-size: 18px; font-weight: bold;">${client}</p>
        </div>
        <div>
          <h4 style="text-transform: uppercase; font-size: 10px; color: #666;">Date</h4>
          <p style="font-size: 18px; font-weight: bold;">${new Date().toLocaleDateString('fr-SN')}</p>
        </div>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 40px;">
        <thead>
          <tr style="background: #F0F4F8; text-align: left;">
            <th style="padding: 12px; border: 1px solid #ddd;">Désignation</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Conteneur</th>
            <th style="padding: 12px; border: 1px solid #ddd; text-align: center;">Quantité</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding: 12px; border: 1px solid #ddd;">${item.produit}</td>
            <td style="padding: 12px; border: 1px solid #ddd;">${item.container_id}</td>
            <td style="padding: 12px; border: 1px solid #ddd; text-align: center; font-weight: bold;">${qte} Cartons</td>
          </tr>
        </tbody>
      </table>

      <div style="margin-top: 100px; display: flex; justify-content: space-between;">
        <div style="text-align: center; width: 200px; border-top: 1px solid #000; padding-top: 10px;">Le Magasinier</div>
        <div style="text-align: center; width: 200px; border-top: 1px solid #000; padding-top: 10px;">Le Transporteur</div>
      </div>
    </div>
  `;
}
