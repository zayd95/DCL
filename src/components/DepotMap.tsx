
import React from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Depot } from '../types';
import L from 'leaflet';

// Fix for default marker icons in Leaflet
import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
    iconUrl: icon,
    shadowUrl: iconShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41]
});

L.Marker.prototype.options.icon = DefaultIcon;

interface DepotMapProps {
  depots: Depot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function DepotMap({ depots, selectedId, onSelect }: DepotMapProps) {
  const center: [number, number] = [14.7167, -17.4677]; // Dakar center

  return (
    <div className="h-[250px] w-full rounded-2xl overflow-hidden shadow-inner border border-gray-100 bg-gray-50">
      <MapContainer center={center} zoom={11} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        {depots.map((depot) => (
          <React.Fragment key={depot.id}>
            <Marker 
              position={[depot.location.lat, depot.location.lng]}
              eventHandlers={{
                click: () => onSelect(depot.id),
              }}
            >
              <Popup>
                <div className="p-1">
                  <h4 className="font-bold m-0">{depot.name}</h4>
                  <p className="text-[10px] m-0 opacity-70">Capacité: {depot.capacity_cartons} CTNS</p>
                </div>
              </Popup>
            </Marker>
            <Circle 
               center={[depot.location.lat, depot.location.lng]}
               radius={1000}
               pathOptions={{ color: depot.color, fillColor: depot.color, fillOpacity: 0.1 }}
            />
          </React.Fragment>
        ))}
      </MapContainer>
    </div>
  );
}
