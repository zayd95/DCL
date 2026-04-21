import { GoogleGenAI, Type } from "@google/genai";
import * as pdfjs from 'pdfjs-dist';

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export interface ExtractedContainer {
  id: string;
  cartons: number;
  description: string;
  weight_kg?: number;
}

export interface ExtractedData {
  supplier: string;
  containers: ExtractedContainer[];
  rawText?: string;
}

/**
 * Main function to parse a document using Gemini 3.1 Pro
 */
export const parseDocument = async (file: File): Promise<ExtractedData> => {
  let imagesBase64: string[] = [];

  if (file.type === 'application/pdf') {
    imagesBase64 = await pdfToImages(file);
  } else {
    const base64 = await fileToBase64(file);
    imagesBase64 = [base64];
  }

  return analyzeWithGemini(imagesBase64);
};

/**
 * Convert File to Base64
 */
const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = error => reject(error);
  });
};

/**
 * Render PDF to images (Base64)
 */
const pdfToImages = async (file: File): Promise<string[]> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const images: string[] = [];

  // Scan first 3 pages
  const pagesToScan = Math.min(pdf.numPages, 3);

  for (let i = 1; i <= pagesToScan; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) continue;

    canvas.height = viewport.height;
    canvas.width = viewport.width;

    await (page.render({ canvasContext: context, viewport } as any)).promise;
    
    const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    images.push(base64);
  }

  return images;
};

/**
 * Use Gemini 3.1 Pro to extract logistics data
 */
const analyzeWithGemini = async (imagesBase64: string[]): Promise<ExtractedData> => {
  const parts = imagesBase64.map(base64 => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: base64,
    },
  }));

  const prompt = `Analyse ce document logistique (Packing List, Invoice ou Bill of Lading). 
  Extrais les informations suivantes :
  1. Le nom du fournisseur (supplier).
  2. La liste des conteneurs avec leur numéro (ID), le nombre de cartons (cartons), la description du produit et le poids en kg si disponible.
  
  Règles :
  - Les numéros de conteneurs suivent le format 4 lettres + 7 chiffres (ex: MSCU1234567).
  - Sois précis sur les quantités de cartons.
  - Si plusieurs conteneurs ont le même produit dans une liste, répète la description.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: { parts: [...parts, { text: prompt }] },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            supplier: { type: Type.STRING, description: "Nom du fournisseur" },
            containers: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: "Numéro de conteneur" },
                  cartons: { type: Type.INTEGER, description: "Nombre de cartons" },
                  description: { type: Type.STRING, description: "Description court du produit" },
                  weight_kg: { type: Type.NUMBER, description: "Poids en kg" }
                },
                required: ["id", "cartons", "description"]
              }
            }
          },
          required: ["supplier", "containers"]
        }
      }
    });

    const result = JSON.parse(response.text);
    return {
      supplier: result.supplier || "FOURNISSEUR INCONNU",
      containers: result.containers || [],
      rawText: response.text
    };
  } catch (error) {
    console.error("Gemini Extraction Error:", error);
    throw new Error("Échec de l'analyse intelligente par Gemini.");
  }
};
