import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import admin from "firebase-admin";
import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import cron from "node-cron";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Global db instance
let db: admin.firestore.Firestore;

async function initDb() {
  // Detection of the real project ID from environment if possible
  const envProjectId = process.env.GOOGLE_CLOUD_PROJECT;
  const configProjectId = firebaseConfig.projectId;
  const actualProjectId = envProjectId || configProjectId;

  const dbId = firebaseConfig.firestoreDatabaseId;
  const isDefault = !dbId || dbId === '(default)';
  const targetDb = isDefault ? '(default)' : dbId;
  
  console.log(`Firebase Admin Init: Env Project [${envProjectId}] / Config Project [${configProjectId}]`);
  console.log(`Firebase Admin Init: Using Project [${actualProjectId}] / DB [${targetDb}]`);
  
  try {
    const app = getApps().length > 0 ? getApp() : initializeApp({
      projectId: actualProjectId,
      credential: admin.credential.applicationDefault()
    });
    
    db = isDefault ? getFirestore(app) : getFirestore(app, dbId);
    
    const testSnap = await db.collection('_health').limit(1).get();
    console.log(`Firebase Admin: [SUCCESS] Verified connection to [${targetDb}]. Found ${testSnap.docs.length} health docs.`);
  } catch (err: any) {
    console.error(`Firebase Admin: [FAILED] connection to [${targetDb}]:`, err.message);
    
    if (getApps().length === 0) {
      console.log("Retrying initialization with param-less init (auto-discovery)...");
      try {
        const app = initializeApp();
        db = isDefault ? getFirestore(app) : getFirestore(app, dbId);
        await db.collection('_health').limit(1).get();
        console.log("Firebase Admin: [SUCCESS] Verified via auto-discovery.");
      } catch (retryErr: any) {
        console.error("Firebase Admin: [CRITICAL] All initialization attempts failed.", retryErr.message);
      }
    }
  }
}

// Start database and then listeners
await initDb();

const app = express();
const PORT = 3000;

app.use(express.json());

// Helper: Notify Admins
async function notifyAdmins(level: 'warning' | 'critical', title: string, body: string) {
  if (!db) return;
  try {
    // 1. Log to Firestore
    await db.collection('alerts').add({
      title,
      body,
      level,
      type: 'system',
      read: false,
      createdAt: FieldValue.serverTimestamp()
    });

    // 2. Logging
    console.log(`[ALERT] ${level.toUpperCase()}: ${title} - ${body}`);
  } catch (err) {
    console.error("Failed to notify admins:", err);
  }
}

// --- REALTIME LISTENERS WRAPPER ---
function setupRealtimeListeners() {
  if (!db) {
    console.error("Firebase Admin: DB not ready. Listeners aborted.");
    return;
  }

  console.log("Firebase Admin: Setting up Realtime Monitoring...");

  // 1. Stock Monitoring (Low Stock Trigger)
  db.collectionGroup('stock').onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      try {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          const thresholdPercentage = data.threshold || 10;
          const initialQty = data.initialQuantity || (data.quantity + 100);
          const currentQty = data.quantity || data.cartons || 0;
          const ratio = (currentQty / initialQty) * 100;

          if (ratio <= thresholdPercentage && currentQty > 0) {
            await notifyAdmins('warning', 'Stock Bas', `Produit ${data.productName || data.product} (Lot ${data.container}) est à ${Math.round(ratio)}%`);
          } else if (currentQty <= 0) {
            await notifyAdmins('critical', 'Rupture de Stock', `Produit ${data.productName || data.product} (Lot ${data.container}) est épuisé!`);
          }
        }
      } catch (err) {
        console.error("Error processing stock change:", err);
      }
    });
  }, (error) => {
    console.error("Critical Error in Stock onSnapshot:", error.message || error);
  });

  // 2. Document Scoring & Compliance (Automated Checklist)
  try {
    db.collection('document_library').onSnapshot((snapshot: any) => {
      snapshot.docChanges().forEach(async (change: any) => {
        if (change.type === 'added') {
          const doc = change.doc.data();
          const containerNo = doc.linkedContainer;
          if (!containerNo) return;

          const fileNameUpper = (doc.fileName || "").toUpperCase();
          const cat = doc.category;
          
          let updates: any = {};
          let scoreIncrement = 0;

          if (fileNameUpper.includes('HALAL') || cat === 'halal_certificate') {
            updates['compliance.halalCertificate'] = true;
            scoreIncrement = 25;
          }
          
          if (fileNameUpper.includes('SANITAIIRE') || fileNameUpper.includes('SANITAIRE') || cat === 'sanitary_certificate') {
            updates['compliance.sanitaryCertificate'] = true;
            scoreIncrement = 25;
          }

          if (cat === 'invoice') {
            updates['compliance.invoice'] = true;
            scoreIncrement = 25;
          }

          if (cat === 'bill_of_lading') {
            updates['compliance.billOfLading'] = true;
            scoreIncrement = 25;
          }

          if (Object.keys(updates).length > 0) {
            try {
              const containersRef = db.collection('containers');
              const q = await containersRef.where('containerNumber', '==', containerNo).get();
              
              for (const containerDoc of q.docs) {
                await containerDoc.ref.update({
                  ...updates,
                  complianceScore: FieldValue.increment(scoreIncrement),
                  updatedAt: FieldValue.serverTimestamp()
                });
                console.log(`Auto-Scoring: Updated compliance for ${containerNo}`);
              }
            } catch (e) {
              console.error("Auto-Scoring Error:", e);
            }
          }
        }
      });
    }, (error: any) => {
       console.error("Critical Error in Document Scoring onSnapshot:", error.message || error);
    });
  } catch (error) {
    console.error("Failed to setup Document Scoring listener:", error);
  }
}

setupRealtimeListeners();

// 2. FEFO Daily Check (08:00 Dakar Time)
cron.schedule('0 8 * * *', async () => {
  console.log("Running Daily FEFO Check...");
  try {
    const now = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(now.getDate() + 30);
    
    const stockSnap = await db.collectionGroup('stock').where('status', '!=', 'cancelled').get();
    
    for (const doc of stockSnap.docs) {
      const data = doc.data();
      if (data.expirationDate) {
        const expDate = data.expirationDate.toDate ? data.expirationDate.toDate() : new Date(data.expirationDate);
        if (expDate < now) {
          await notifyAdmins('critical', 'PRODUIT EXPIRÉ', `${data.productName || data.product} (Lot ${data.container}) a expiré.`);
        } else if (expDate < thirtyDaysFromNow) {
          await notifyAdmins('warning', 'Alerte FEFO', `${data.productName || data.product} expire bientôt (${expDate.toLocaleDateString()})`);
        }
      }
    }
  } catch (error) {
    console.error("Error in FEFO Cron Job:", error);
  }
});

// 3. Container Tracking Simulator (Every 10 minutes)
cron.schedule('*/10 * * * *', async () => {
  console.log('Running Container Tracking Simulator...');
  try {
    if (!db) {
      console.error("Tracking Job aborted: DB not initialized");
      return;
    }

    const now = new Date();
    let containerSnap;
    try {
      // Primary attempt: Filtered query (requires index and specific permissions)
      containerSnap = await db.collection('containers')
        .where('status', 'in', ['at_sea', 'port_arrival'])
        .get();
      console.log(`Tracking Job: Found ${containerSnap.docs.length} containers to check.`);
    } catch (e: any) {
      console.warn("Tracking Job: Filtered fetch failed, attempting fallback to full fetch...", e.message);
      try {
        // Fallback: Fetch all and filter in memory if the filtered query is blocked
        const fullSnap = await db.collection('containers').get();
        const filteredDocs = fullSnap.docs.filter(d => ['at_sea', 'port_arrival'].includes(d.data().status));
        containerSnap = { docs: filteredDocs };
        console.log(`Tracking Job (Fallback): Found ${filteredDocs.length} containers to check.`);
      } catch (fallbackError: any) {
        console.error("Tracking Job: CRITICAL - All container fetch methods failed:", fallbackError.message);
        throw fallbackError;
      }
    }

    for (const doc of containerSnap.docs) {
      const data = doc.data();
      if (!data.eta) continue;
      
      const eta = data.eta.toDate ? data.eta.toDate() : new Date(data.eta);
      
      // If ETA is reached, move to port_arrival
      if (data.status === 'at_sea' && now >= eta) {
        try {
          await doc.ref.update({ 
            status: 'port_arrival',
            updatedAt: FieldValue.serverTimestamp()
          });
          
          await notifyAdmins(
            'warning',
            'Arrivée Port (PAD)', 
            `Le conteneur ${data.containerNumber} est arrivé au Port Autonome de Dakar.`
          );
          console.log(`Tracking Job: Updated container ${data.containerNumber} to port_arrival.`);
        } catch (e: any) {
          console.error(`Tracking Job: Failed to UPDATE container ${data.containerNumber}:`, e.message);
        }
      }
    }
  } catch (error: any) {
    console.error("Error in Tracking Cron Job SUMMARY:", error.message || error);
    if (error.message?.includes("PERMISSION_DENIED")) {
       console.error("IAM ROLE CHECK: Ensure Service Account has 'Cloud Datastore User' on the target database.");
    }
  }
});

// --- API ROUTES ---

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Get Alerts
app.get("/api/alerts", async (req, res) => {
  try {
    const snap = await db.collection('alerts').orderBy('createdAt', 'desc').limit(50).get();
    const alerts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// mark-read
app.post("/api/alerts/:id/read", async (req, res) => {
  try {
    await db.collection('alerts').doc(req.params.id).update({ read: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Diagnostics Route
app.get("/api/db-diagnostics", async (req, res) => {
  try {
    const collections = await db.listCollections();
    const collectionNames = collections.map((c: any) => c.id);
    res.json({
      database: (db as any).databaseId || '(default)',
      projectId: (db as any).projectId || firebaseConfig.projectId,
      collections: collectionNames,
      status: "connected"
    });
  } catch (err) {
    res.status(500).json({ 
      error: err instanceof Error ? err.message : String(err),
      database: (db as any)?.databaseId || 'unknown'
    });
  }
});

// Test Push Route
app.post("/api/test-push", async (req, res) => {
  try {
    await notifyAdmins('warning', 'Test Système', 'Ceci est une notification de test pour le PAD Hub.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Vite Middleware
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`FEFO monitoring active (Cron: 08:00)`);
  });
}

startServer();
