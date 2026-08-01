/**
 * The freight model. Deterministic, never random.
 *
 * A delivery cost that changes when you reload the page destroys the whole
 * product's credibility, so there is no Math.random() in this file and there
 * never will be. Where a vendor's location genuinely cannot be resolved we
 * fall back to a value derived from a hash of the vendor id — stable across
 * every page load, every refresh and every process restart.
 *
 * Shape:  distance band  ×  chargeable weight  ×  vehicle class
 *         → category minimum → vendor free-delivery threshold → amortise
 *
 * Every figure this module produces renders with an ESTIMATED badge and a
 * one-tap breakdown containing the arithmetic below.
 */

import { Paise, roundHalfUp } from './money';

export type VehicleClass = 'parcel' | 'tempo' | 'lcv' | '6_tyre' | '10_tyre';

export interface VehicleSpec {
  vclass: VehicleClass;
  maxKg: number;
  perKmPaise: Paise;
  minTripPaise: Paise;
  label: string;
}

/**
 * Rates are the TYPICAL rung of the missing-data ladder: representative Indian
 * road-freight rates for the Hyderabad/Vijayawada corridor, not a quote from
 * any named transporter. They are shown as ESTIMATED wherever they surface, and
 * a vendor's own published freight always overrides them.
 */
export const VEHICLES: VehicleSpec[] = [
  { vclass: 'parcel',  maxKg: 50,     perKmPaise: 0,    minTripPaise: 8_000,   label: 'Parcel / courier' },
  { vclass: 'tempo',   maxKg: 1_500,  perKmPaise: 2_400, minTripPaise: 45_000,  label: 'Tempo (Tata Ace class)' },
  { vclass: 'lcv',     maxKg: 3_500,  perKmPaise: 3_000, minTripPaise: 90_000,  label: 'LCV (407 class)' },
  { vclass: '6_tyre',  maxKg: 9_000,  perKmPaise: 3_800, minTripPaise: 160_000, label: '6-tyre truck' },
  { vclass: '10_tyre', maxKg: 16_000, perKmPaise: 5_200, minTripPaise: 300_000, label: '10-tyre truck' },
];

/** Parcel freight is weight-based rather than distance-based. */
const PARCEL_BASE_PAISE = 8_000;
const PARCEL_PER_KG_PAISE = 600;

export const DISTANCE_BANDS: Array<{ band: string; maxKm: number; label: string }> = [
  { band: 'local',      maxKm: 15,       label: 'within the city' },
  { band: 'metro',      maxKm: 40,       label: 'city outskirts' },
  { band: 'regional',   maxKm: 100,      label: 'district' },
  { band: 'inter_city', maxKm: 250,      label: 'inter-city' },
  { band: 'long_haul',  maxKm: Infinity, label: 'long haul' },
];

/**
 * Handling and loading are itemised separately and never folded into the base
 * price — folding them in is basket sneaking under the CCPA Dark Patterns
 * Guidelines 2023, and it is also how competitors hide 25% of the real cost.
 */
export const CATEGORY_LOGISTICS: Record<
  string,
  { loadingPerUnitPaise: Paise; handlingPerKgPaise: Paise; minHandlingPaise: Paise; referenceQty: number; refUnit: string }
> = {
  cement:        { loadingPerUnitPaise: 200, handlingPerKgPaise: 25, minHandlingPaise: 4_000, referenceQty: 50,   refUnit: 'bag' },
  tmt_steel:     { loadingPerUnitPaise: 30,  handlingPerKgPaise: 20, minHandlingPaise: 5_000, referenceQty: 1000, refUnit: 'kg' },
  water_pipes:   { loadingPerUnitPaise: 300, handlingPerKgPaise: 40, minHandlingPaise: 3_000, referenceQty: 20,   refUnit: 'length' },
  bricks_blocks: { loadingPerUnitPaise: 35,  handlingPerKgPaise: 15, minHandlingPaise: 4_000, referenceQty: 1000, refUnit: 'piece' },
};

/** Road-freight volumetric divisor: 250 kg per cubic metre for LTL in India. */
const VOLUMETRIC_KG_PER_M3 = 250;

export interface Geo { lat: number; lon: number }

export function haversineKm(a: Geo, b: Geo): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Road distance is longer than great-circle. 1.32 is the standard Indian
 * road-circuity factor for plains terrain.
 */
const CIRCUITY = 1.32;

/** FNV-1a. Deterministic, stable across processes — this is the whole point. */
export function seedFromId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * When a vendor's locality cannot be geocoded, derive a stable distance in
 * [6, 42] km from the vendor id. Identical on every page load and every
 * refresh, for the life of that vendor id.
 */
export function fallbackDistanceKm(vendorId: string): number {
  const s = seedFromId(vendorId);
  return +(6 + (s % 3601) / 100).toFixed(2); // 6.00 .. 42.00
}

export function bandFor(km: number): { band: string; label: string } {
  const b = DISTANCE_BANDS.find((d) => km <= d.maxKm)!;
  return { band: b.band, label: b.label };
}

export function vehicleFor(chargeableKg: number): VehicleSpec {
  return VEHICLES.find((v) => chargeableKg <= v.maxKg) ?? VEHICLES[VEHICLES.length - 1];
}

export interface FreightInput {
  vendorId: string;
  vendorGeo: Geo | null;
  destGeo: Geo;
  category: string;
  /** Mass of one trade unit (one bag, one rod, one length, one brick). */
  unitWeightKg: number;
  unitVolumeM3?: number | null;
  /** Quantity the delivered rate is quoted against — the seller's MOQ if published. */
  amortiseQty: number;
  /** Order value ex-freight, for the free-delivery threshold test. */
  orderValuePaise: Paise;
  vendorFreeDeliveryThresholdPaise?: Paise | null;
  /** A freight figure the vendor actually published, which always wins. */
  vendorPublishedFreightPaise?: Paise | null;
}

export interface FreightResult {
  freightPaise: Paise;      // per trade unit
  handlingPaise: Paise;     // per trade unit
  loadingPaise: Paise;      // per trade unit
  vehicleClass: VehicleClass;
  vehicleLabel: string;
  distanceKm: number;
  distanceBand: string;
  distanceBandLabel: string;
  chargeableKg: number;
  trips: number;
  tripCostPaise: Paise;
  amortiseQty: number;
  basis: 'computed' | 'seeded_fallback' | 'vendor_published' | 'free_delivery';
  estimated: boolean;
  /** The arithmetic, rendered one tap away from every delivery figure. */
  breakdown: Array<{ step: string; detail: string; value?: string }>;
}

export function computeFreight(input: FreightInput): FreightResult {
  const {
    vendorId, vendorGeo, destGeo, category, unitWeightKg, unitVolumeM3,
    amortiseQty, orderValuePaise, vendorFreeDeliveryThresholdPaise, vendorPublishedFreightPaise,
  } = input;

  const logistics = CATEGORY_LOGISTICS[category] ?? CATEGORY_LOGISTICS.cement;
  const qty = Math.max(1, amortiseQty);
  const breakdown: FreightResult['breakdown'] = [];

  // ── 1. distance ────────────────────────────────────────────────────────────
  let distanceKm: number;
  let basis: FreightResult['basis'];
  if (vendorGeo) {
    const straight = haversineKm(vendorGeo, destGeo);
    distanceKm = +(straight * CIRCUITY).toFixed(2);
    basis = 'computed';
    breakdown.push({
      step: 'Distance',
      detail: `${straight.toFixed(1)} km straight line × 1.32 road-circuity factor`,
      value: `${distanceKm} km`,
    });
  } else {
    distanceKm = fallbackDistanceKm(vendorId);
    basis = 'seeded_fallback';
    breakdown.push({
      step: 'Distance',
      detail: `Seller locality could not be geocoded. Distance derived from a hash of the seller id, so it is identical on every page load — never re-rolled.`,
      value: `${distanceKm} km`,
    });
  }
  const band = bandFor(distanceKm);
  breakdown.push({ step: 'Distance band', detail: band.label, value: band.band });

  // ── 2. chargeable weight ───────────────────────────────────────────────────
  const actualKg = unitWeightKg * qty;
  const volumetricKg = unitVolumeM3 ? unitVolumeM3 * qty * VOLUMETRIC_KG_PER_M3 : 0;
  const chargeableKg = Math.max(actualKg, volumetricKg);
  breakdown.push({
    step: 'Chargeable weight',
    detail: volumetricKg > actualKg
      ? `${qty} × ${unitVolumeM3} m³ × ${VOLUMETRIC_KG_PER_M3} kg/m³ volumetric — bulkier than it is heavy`
      : `${qty} × ${unitWeightKg} kg actual`,
    value: `${Math.round(chargeableKg)} kg`,
  });

  // ── 3. vehicle and trips ───────────────────────────────────────────────────
  const vehicle = vehicleFor(chargeableKg);
  const trips = Math.max(1, Math.ceil(chargeableKg / vehicle.maxKg));
  breakdown.push({
    step: 'Vehicle',
    detail: `${vehicle.label}, capacity ${vehicle.maxKg.toLocaleString('en-IN')} kg${trips > 1 ? ` — ${trips} trips needed` : ''}`,
    value: vehicle.vclass,
  });

  // ── 4. trip cost ───────────────────────────────────────────────────────────
  let tripCostPaise: Paise;
  if (vehicle.vclass === 'parcel') {
    tripCostPaise = PARCEL_BASE_PAISE + roundHalfUp(chargeableKg * PARCEL_PER_KG_PAISE);
    breakdown.push({
      step: 'Trip cost',
      detail: `₹${PARCEL_BASE_PAISE / 100} base + ${Math.round(chargeableKg)} kg × ₹${PARCEL_PER_KG_PAISE / 100}/kg`,
      value: `₹${(tripCostPaise / 100).toFixed(2)}`,
    });
  } else {
    const byDistance = roundHalfUp(distanceKm * vehicle.perKmPaise);
    tripCostPaise = Math.max(byDistance, vehicle.minTripPaise) * trips;
    breakdown.push({
      step: 'Trip cost',
      detail:
        `${distanceKm} km × ₹${vehicle.perKmPaise / 100}/km = ₹${(byDistance / 100).toFixed(0)}` +
        (byDistance < vehicle.minTripPaise ? `, below the ₹${vehicle.minTripPaise / 100} minimum for this vehicle` : '') +
        (trips > 1 ? ` × ${trips} trips` : ''),
      value: `₹${(tripCostPaise / 100).toFixed(2)}`,
    });
  }

  // ── 5. vendor overrides ────────────────────────────────────────────────────
  if (vendorPublishedFreightPaise != null) {
    tripCostPaise = vendorPublishedFreightPaise * qty;
    basis = 'vendor_published';
    breakdown.push({
      step: 'Seller published rate',
      detail: `This seller publishes a delivery charge, which replaces the model entirely.`,
      value: `₹${(vendorPublishedFreightPaise / 100).toFixed(2)} per unit`,
    });
  }

  let freightPerUnit = roundHalfUp(tripCostPaise / qty);

  if (
    vendorFreeDeliveryThresholdPaise != null &&
    orderValuePaise >= vendorFreeDeliveryThresholdPaise
  ) {
    freightPerUnit = 0;
    basis = 'free_delivery';
    breakdown.push({
      step: 'Free delivery',
      detail: `Order value ₹${(orderValuePaise / 100).toFixed(0)} clears this seller's published free-delivery threshold of ₹${(vendorFreeDeliveryThresholdPaise / 100).toFixed(0)}.`,
      value: '₹0.00',
    });
  } else {
    breakdown.push({
      step: 'Freight per unit',
      detail: `Trip cost amortised across ${qty} ${logistics.refUnit}${qty > 1 ? 's' : ''} — the quantity this delivered rate is quoted against.`,
      value: `₹${(freightPerUnit / 100).toFixed(2)}`,
    });
  }

  // ── 6. handling and loading, itemised separately ───────────────────────────
  const handlingTotal = Math.max(logistics.minHandlingPaise, roundHalfUp(chargeableKg * logistics.handlingPerKgPaise));
  const handlingPerUnit = roundHalfUp(handlingTotal / qty);
  const loadingPerUnit = logistics.loadingPerUnitPaise;

  breakdown.push({
    step: 'Handling',
    detail: `${Math.round(chargeableKg)} kg × ₹${logistics.handlingPerKgPaise / 100}/kg (minimum ₹${logistics.minHandlingPaise / 100}), amortised across ${qty}`,
    value: `₹${(handlingPerUnit / 100).toFixed(2)}`,
  });
  breakdown.push({
    step: 'Loading / unloading',
    detail: `Site labour, per ${logistics.refUnit}`,
    value: `₹${(loadingPerUnit / 100).toFixed(2)}`,
  });

  return {
    freightPaise: freightPerUnit,
    handlingPaise: handlingPerUnit,
    loadingPaise: loadingPerUnit,
    vehicleClass: vehicle.vclass,
    vehicleLabel: vehicle.label,
    distanceKm,
    distanceBand: band.band,
    distanceBandLabel: band.label,
    chargeableKg: +chargeableKg.toFixed(1),
    trips,
    tripCostPaise,
    amortiseQty: qty,
    basis,
    estimated: basis !== 'vendor_published',
    breakdown,
  };
}
