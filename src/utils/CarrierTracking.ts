// Mapping préfixe → carrier + URL tracking direct
const CARRIER_URLS: Record<string, { name: string; color: string; url: (n: string) => string }> = {
  // MSC
  'MSCU': { name: 'MSC', color: '#1a5490', url: (n) => `https://www.msc.com/track-a-shipment?trackingNumber=${n}` },
  'MSDU': { name: 'MSC', color: '#1a5490', url: (n) => `https://www.msc.com/track-a-shipment?trackingNumber=${n}` },
  'MSKU': { name: 'MSC', color: '#1a5490', url: (n) => `https://www.msc.com/track-a-shipment?trackingNumber=${n}` },
  // MAERSK
  'MAEU': { name: 'MAERSK', color: '#42b0d5', url: (n) => `https://www.maersk.com/tracking/#/tracking-results?trackingNumber=${n}` },
  'MRKU': { name: 'MAERSK', color: '#42b0d5', url: (n) => `https://www.maersk.com/tracking/#/tracking-results?trackingNumber=${n}` },
  // CMA CGM
  'APZU': { name: 'CMA CGM', color: '#e31937', url: (n) => `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&SearchNumber=${n}` },
  'CMAU': { name: 'CMA CGM', color: '#e31937', url: (n) => `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&SearchNumber=${n}` },
  // HAPAG-LLOYD
  'HLXU': { name: 'HAPAG-LLOYD', color: '#001f3f', url: (n) => `https://www.hapag-lloyd.com/en/online-business/track/track-by-container.html?container=${n}` },
  'HLCU': { name: 'HAPAG-LLOYD', color: '#001f3f', url: (n) => `https://www.hapag-lloyd.com/en/online-business/track/track-by-container.html?container=${n}` },
  // ONE
  'ONEY': { name: 'ONE', color: '#ff1693', url: (n) => `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trackingNo=${n}` },
  'ONEL': { name: 'ONE', color: '#ff1693', url: (n) => `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trackingNo=${n}` },
  // EVERGREEN
  'EMCU': { name: 'EVERGREEN', color: '#009944', url: (n) => `https://www.evergreen-line.com/en/track-and-trace?container=${n}` },
  'EISU': { name: 'EVERGREEN', color: '#009944', url: (n) => `https://www.evergreen-line.com/en/track-and-trace?container=${n}` },
  // COSCO
  'COSU': { name: 'COSCO', color: '#003366', url: (n) => `https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number=${n}` },
  'CBHU': { name: 'COSCO', color: '#003366', url: (n) => `https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number=${n}` },
};

export const detectCarrier = (containerNumber: string) => {
  if (!containerNumber || containerNumber.length < 4) return null;
  const prefix = containerNumber.substring(0, 4).toUpperCase();
  return CARRIER_URLS[prefix] || null;
};

export const getTrackingUrl = (containerNumber: string) => {
  const carrier = detectCarrier(containerNumber);
  if (carrier) {
    return { url: carrier.url(containerNumber), carrier: carrier.name, color: carrier.color };
  }
  // Fallback 17TRACK
  return { url: `https://www.17track.net/en/track?nums=${containerNumber}`, carrier: 'UNKNOWN', color: '#666' };
};
