
import { db } from './firebase';
import { collection, doc, setDoc } from 'firebase/firestore';

const initialDepots = [
  {
    id: 'bel_air',
    name: 'Bel-Air (Quai)',
    location: { lat: 14.6865, lng: -17.4335 },
    manager_uid: 'Habib J.',
    capacity_cartons: 5000,
    current_load: 0,
    temp_range: '-20°C / -25°C',
    color: '#0066FF'
  },
  {
    id: 'mbao',
    name: 'Mbao (Zone Franche)',
    location: { lat: 14.7482, lng: -17.2764 },
    manager_uid: 'Samba D.',
    capacity_cartons: 15000,
    current_load: 0,
    temp_range: '-18°C / -22°C',
    color: '#00C853'
  },
  {
    id: 'diamniadio',
    name: 'Diamniadio Hub',
    location: { lat: 14.7333, lng: -17.2000 },
    manager_uid: 'Awa N.',
    capacity_cartons: 25000,
    current_load: 0,
    temp_range: '-20°C / -25°C',
    color: '#FF6B6B'
  },
  {
    id: 'thiaroye',
    name: 'Thiaroye Sud',
    location: { lat: 14.7500, lng: -17.3500 },
    manager_uid: 'Moussa F.',
    capacity_cartons: 10000,
    current_load: 0,
    temp_range: '-18°C / -22°C',
    color: '#FFB800'
  },
  {
    id: 'almadi_2',
    name: 'ALMADI 2',
    location: { lat: 14.7400, lng: -17.5100 },
    manager_uid: 'Habib J.',
    capacity_cartons: 8000,
    current_load: 0,
    temp_range: '-20°C / -25°C',
    color: '#9C27B0'
  }
];

export async function seedDepots() {
  for (const depot of initialDepots) {
    await setDoc(doc(db, 'depots', depot.id), depot);
  }
}

export async function seedV2Demo() {
  const containers = [
    { id: 'MSDU9889624', qty: 1444, prod: 'INDIAN FROZEN BONELESS BUFFALO' },
    { id: 'MSDU9744868', qty: 1420, prod: 'INDIAN FROZEN BONELESS BUFFALO' },
    { id: 'MEDU9661323', qty: 1420, prod: 'INDIAN FROZEN BONELESS BUFFALO' },
    { id: 'MSDU9797512', qty: 1420, prod: 'INDIAN FROZEN BONELESS BUFFALO' }
  ];

  for (const c of containers) {
    const stockRef = doc(collection(db, 'stock'));
    await setDoc(stockRef, {
      id: stockRef.id,
      container: c.id,
      product: c.prod,
      cartons: c.qty,
      cost_basis: 45000 * c.qty,
      arrival_date: new Date().toISOString(),
      depot_id: 'bel_air',
      status: 'quay_pad',
      fefo_score: 0,
      aging_days: 0,
      source_doc: {
        invoice_no: 'OAG/2503/25-26',
        supplier: 'OLIVE ALBATROZ GENERAL TRADING'
      },
      createdAt: new Date().toISOString()
    });
  }
}
