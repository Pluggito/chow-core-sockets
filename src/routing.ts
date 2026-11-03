export type DeliveryCoordinate = {
  lat: number;
  lng: number;
};

export type TravelMode = 'walking' | 'driving';

export type TravelEstimate = {
  distanceKm: number;
  durationMinutes: number;
};

export type RoutingContext = {
  trafficMultiplier?: number;
  noiseMinutes?: number;
  averageSpeedKph?: number;
};

export interface RoutingEngine {
  estimateTravelTime(
    from: DeliveryCoordinate,
    to: DeliveryCoordinate,
    mode: TravelMode,
    context?: RoutingContext
  ): Promise<TravelEstimate>;
}

export type DispatchWeights = {
  arrivalToVendor: number;
  pickupDelay: number;
  incrementalTime: number;
  routeDetour: number;
  workload: number;
  slaRisk: number;
};

export const DEFAULT_DISPATCH_WEIGHTS: DispatchWeights = {
  arrivalToVendor: 0.25,
  pickupDelay: 2.0,
  incrementalTime: 1.0,
  routeDetour: 2.0,
  workload: 0.25,
  slaRisk: 100.0,
};

export type DispatchRider = DeliveryCoordinate & {
  id: string;
  name?: string;
  status: string;
  vehicleType?: string;
  maxActiveDeliveries?: number;
  currentOrderCount: number;
  estimatedCompletionOfCurrentOrdersMins?: number;
  expectedLocation?: DeliveryCoordinate;
};

export type DispatchScoreComponent = {
  name: string;
  value: number;
  weight: number;
  contribution: number;
};

export type DispatchCandidate = DispatchRider & {
  riderToVendorKm: number;
  vendorToCustomerKm: number;
  directToCustomerKm: number;
  combinedDistanceKm: number;
  incrementalDistanceKm: number;
  incrementalTimeMinutes: number;
  estimatedTravelToVendorMins: number;
  deliveryTravelMins: number;
  riderAvailableInMins: number;
  pickupWaitMins: number;
  pickupDelayMins: number;
  waitingPenaltyMins: number;
  deliveryEtaMins: number;
  slaMissed: boolean;
  dispatchScore: number;
  scoreComponents: DispatchScoreComponent[];
};

const DEFAULT_PICKUP_SERVICE_MINUTES = 3;
const DEFAULT_MAX_PICKUP_ETA_MINUTES = 30;
const DEFAULT_MAX_DELIVERY_MINUTES = 90;

export function isValidCoordinate(coordinate: DeliveryCoordinate): boolean {
  return (
    typeof coordinate === 'object' &&
    coordinate !== null &&
    Number.isFinite(coordinate.lat) &&
    Number.isFinite(coordinate.lng) &&
    coordinate.lat >= -90 &&
    coordinate.lat <= 90 &&
    coordinate.lng >= -180 &&
    coordinate.lng <= 180
  );
}

export function haversineDistanceKm(
  from: DeliveryCoordinate,
  to: DeliveryCoordinate
): number {
  const earthRadiusKm = 6371;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;

  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const detourCorrectionFactor = 1.3;

  return earthRadiusKm * c * detourCorrectionFactor;
}

export function getVehicleSpeedKph(vehicleType?: string): number {
  const normalized = (vehicleType || 'walker').toLowerCase();
  switch (normalized) {
    case 'walker':
    case 'trekker':
      return 5.5;
    case 'bicycle':
    case 'bike':
      return 15.0;
    case 'shuttle':
    case 'motorcycle':
      return 22.0;
    default:
      return 15.0;
  }
}

export function getVehicleTravelMode(vehicleType?: string): TravelMode {
  const normalized = (vehicleType || 'walker').toLowerCase();
  if (normalized === 'walker' || normalized === 'trekker') {
    return 'walking';
  }
  return 'driving';
}

export function getVehicleMaxCapacity(rider: DispatchRider): number {
  if (typeof rider.maxActiveDeliveries === 'number' && rider.maxActiveDeliveries > 0) {
    return rider.maxActiveDeliveries;
  }
  const normalized = (rider.vehicleType || 'walker').toLowerCase();
  if (normalized === 'shuttle' || normalized === 'motorcycle') return 4;
  if (normalized === 'bicycle') return 3;
  return 2;
}

export class HaversineRoutingEngine implements RoutingEngine {
  constructor(private readonly defaultSpeedKph = 15) {}

  async estimateTravelTime(
    from: DeliveryCoordinate,
    to: DeliveryCoordinate,
    mode: TravelMode,
    context: RoutingContext = {}
  ): Promise<TravelEstimate> {
    const distanceKm = haversineDistanceKm(from, to);
    const trafficMultiplier = context.trafficMultiplier ?? 1;
    const noiseMinutes = context.noiseMinutes ?? 0;
    const defaultModeSpeed = mode === 'walking' ? 5.5 : this.defaultSpeedKph;
    const speedKph = context.averageSpeedKph ?? defaultModeSpeed;
    const durationMinutes = Math.max(
      1,
      (distanceKm / speedKph) * 60 * trafficMultiplier + noiseMinutes
    );
    return { distanceKm, durationMinutes };
  }
}

export class ValhallaRoutingEngine implements RoutingEngine {
  private cache = new Map<string, TravelEstimate>();
  private pendingRequests = new Map<string, Promise<TravelEstimate>>();
  private warnedErrors = new Set<string>();
  private haversineFallback = new HaversineRoutingEngine();
  private baseUrl: string;

  public stats = {
    apiRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    walkingRoutes: 0,
    drivingRoutes: 0,
    routeFailures: 0,
    haversineFallbacks: 0,
  };

  constructor(customUrl?: string) {
    const raw = customUrl || process.env.VALHALLA_URL || '';
    this.baseUrl = raw.replace(/\/route\/?$/, '').replace(/\/+$/, '');
  }

  private getCacheKey(from: DeliveryCoordinate, to: DeliveryCoordinate, mode: TravelMode): string {
    return `${mode}:${from.lat.toFixed(5)},${from.lng.toFixed(5)}->${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
  }

  private applyContext(estimate: TravelEstimate, context: RoutingContext): TravelEstimate {
    const trafficMultiplier = context.trafficMultiplier ?? 1;
    const noiseMinutes = context.noiseMinutes ?? 0;
    const durationMinutes = Math.max(
      1,
      estimate.durationMinutes * trafficMultiplier + noiseMinutes
    );
    return {
      distanceKm: estimate.distanceKm,
      durationMinutes,
    };
  }

  private async fetchFromValhalla(
    from: DeliveryCoordinate,
    to: DeliveryCoordinate,
    profile: string
  ): Promise<TravelEstimate> {
    this.stats.apiRequests++;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch(`${this.baseUrl}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locations: [
            { lat: from.lat, lon: from.lng },
            { lat: to.lat, lon: to.lng },
          ],
          costing: profile,
          units: 'kilometers',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Valhalla HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!data?.trip?.summary) {
        throw new Error('Missing Valhalla trip summary');
      }

      return {
        distanceKm: Number(data.trip.summary.length) || 0,
        durationMinutes: (Number(data.trip.summary.time) || 0) / 60,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async estimateTravelTime(
    from: DeliveryCoordinate,
    to: DeliveryCoordinate,
    mode: TravelMode,
    context: RoutingContext = {}
  ): Promise<TravelEstimate> {
    if (!this.baseUrl) {
      this.stats.haversineFallbacks++;
      return this.haversineFallback.estimateTravelTime(from, to, mode, context);
    }

    const isWalking = mode === 'walking';
    const profile = isWalking ? 'pedestrian' : 'motorcycle';
    const cacheKey = this.getCacheKey(from, to, mode);

    if (isWalking) this.stats.walkingRoutes++;
    else this.stats.drivingRoutes++;

    if (this.cache.has(cacheKey)) {
      this.stats.cacheHits++;
      return this.applyContext(this.cache.get(cacheKey)!, context);
    }

    if (this.pendingRequests.has(cacheKey)) {
      this.stats.cacheHits++;
      try {
        const res = await this.pendingRequests.get(cacheKey)!;
        return this.applyContext(res, context);
      } catch {
        // Fall through to Haversine fallback
      }
    } else {
      this.stats.cacheMisses++;
    }

    const requestPromise = this.fetchFromValhalla(from, to, profile)
      .then((res) => {
        this.cache.set(cacheKey, res);
        return res;
      })
      .finally(() => {
        this.pendingRequests.delete(cacheKey);
      });

    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const res = await requestPromise;
      return this.applyContext(res, context);
    } catch (err: any) {
      this.stats.routeFailures++;
      this.stats.haversineFallbacks++;
      const message = err?.message || 'Unknown error';
      if (!this.warnedErrors.has(message)) {
        console.warn(`[ValhallaRoutingEngine] ${message}. Falling back to Haversine.`);
        this.warnedErrors.add(message);
      }
      return this.haversineFallback.estimateTravelTime(from, to, mode, context);
    }
  }
}

function shortlistByEta(
  riders: DispatchRider[],
  vendor: DeliveryCoordinate,
  shortlistSize: number
): DispatchRider[] {
  const eligible = riders.filter(
    (rider) =>
      (rider.status === 'online' || rider.status === 'active') &&
      rider.currentOrderCount < getVehicleMaxCapacity(rider) &&
      isValidCoordinate(rider.expectedLocation ?? rider)
  );

  eligible.sort((a, b) => {
    const aStart = a.expectedLocation && isValidCoordinate(a.expectedLocation) ? a.expectedLocation : a;
    const bStart = b.expectedLocation && isValidCoordinate(b.expectedLocation) ? b.expectedLocation : b;
    const aWorkload = Math.max(0, a.estimatedCompletionOfCurrentOrdersMins || 0);
    const bWorkload = Math.max(0, b.estimatedCompletionOfCurrentOrdersMins || 0);
    const aDistKm = haversineDistanceKm(aStart, vendor);
    const bDistKm = haversineDistanceKm(bStart, vendor);
    const aEta = aWorkload + (aDistKm / getVehicleSpeedKph(a.vehicleType)) * 60;
    const bEta = bWorkload + (bDistKm / getVehicleSpeedKph(b.vehicleType)) * 60;
    return aEta - bEta;
  });

  return eligible.slice(0, Math.max(shortlistSize, 1));
}

function buildCandidateFromEstimates(
  rider: DispatchRider,
  toVendor: TravelEstimate,
  vendorToCustomer: TravelEstimate,
  directToCustomer: TravelEstimate,
  estimatedPrepMins: number,
  weights: DispatchWeights,
  maxDeliveryMinutes: number
): DispatchCandidate {
  const currentWorkloadMins = Math.max(0, rider.estimatedCompletionOfCurrentOrdersMins || 0);
  const etaToVendorMins = currentWorkloadMins + toVendor.durationMinutes;
  const pickupWaitMins = Math.max(0, estimatedPrepMins - etaToVendorMins);
  const pickupDelayMins = Math.max(0, etaToVendorMins - estimatedPrepMins);

  const deliveryEtaMins =
    Math.max(etaToVendorMins, estimatedPrepMins) +
    DEFAULT_PICKUP_SERVICE_MINUTES +
    vendorToCustomer.durationMinutes;

  const slaLatenessMinutes = Math.max(0, deliveryEtaMins - maxDeliveryMinutes);
  const slaMissed = slaLatenessMinutes > 0;

  const incrementalDistanceKm = Math.max(
    0,
    toVendor.distanceKm + vendorToCustomer.distanceKm - directToCustomer.distanceKm
  );
  const incrementalTimeMinutes = Math.max(
    0,
    etaToVendorMins + pickupWaitMins + vendorToCustomer.durationMinutes - directToCustomer.durationMinutes
  );

  const scoreComponents: DispatchScoreComponent[] = [
    {
      name: 'arrival-to-vendor',
      value: etaToVendorMins,
      weight: weights.arrivalToVendor,
      contribution: etaToVendorMins * weights.arrivalToVendor,
    },
    {
      name: 'pickup-delay',
      value: pickupDelayMins,
      weight: weights.pickupDelay,
      contribution: pickupDelayMins * weights.pickupDelay,
    },
    {
      name: 'incremental-time',
      value: incrementalTimeMinutes,
      weight: weights.incrementalTime,
      contribution: incrementalTimeMinutes * weights.incrementalTime,
    },
    {
      name: 'route-detour',
      value: incrementalDistanceKm,
      weight: weights.routeDetour,
      contribution: incrementalDistanceKm * weights.routeDetour,
    },
    {
      name: 'workload',
      value: currentWorkloadMins,
      weight: weights.workload,
      contribution: currentWorkloadMins * weights.workload,
    },
    {
      name: 'sla-risk',
      value: slaLatenessMinutes,
      weight: weights.slaRisk,
      contribution: slaLatenessMinutes * weights.slaRisk,
    },
  ];

  const dispatchScore = scoreComponents.reduce((sum, c) => sum + c.contribution, 0);
  const waitingPenaltyMins = pickupDelayMins > 0 ? pickupDelayMins * 1.5 : pickupWaitMins;

  return {
    ...rider,
    riderToVendorKm: toVendor.distanceKm,
    vendorToCustomerKm: vendorToCustomer.distanceKm,
    directToCustomerKm: directToCustomer.distanceKm,
    combinedDistanceKm: toVendor.distanceKm + vendorToCustomer.distanceKm,
    incrementalDistanceKm,
    incrementalTimeMinutes,
    estimatedTravelToVendorMins: toVendor.durationMinutes,
    deliveryTravelMins: vendorToCustomer.durationMinutes,
    riderAvailableInMins: etaToVendorMins,
    pickupWaitMins,
    pickupDelayMins,
    waitingPenaltyMins,
    deliveryEtaMins,
    slaMissed,
    dispatchScore,
    scoreComponents,
  };
}

export async function rankDispatchCandidatesAsync(
  riders: DispatchRider[],
  vendor: DeliveryCoordinate,
  customer: DeliveryCoordinate,
  estimatedPrepMins: number = 15,
  limit = 5,
  options: {
    routing?: RoutingEngine;
    weights?: Partial<DispatchWeights>;
    trafficMultiplier?: number;
    maxPickupEtaMinutes?: number;
    maxDeliveryMinutes?: number;
  } = {}
): Promise<DispatchCandidate[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Candidate limit must be a positive integer');
  }

  const routing = options.routing ?? new ValhallaRoutingEngine();
  const mergedWeights: DispatchWeights = { ...DEFAULT_DISPATCH_WEIGHTS, ...options.weights };
  const maxPickupEta = options.maxPickupEtaMinutes ?? DEFAULT_MAX_PICKUP_ETA_MINUTES;
  const maxDelivery = options.maxDeliveryMinutes ?? DEFAULT_MAX_DELIVERY_MINUTES;

  // Stage 1: ETA-aware pre-filter (shortlist-eta-K)
  const shortlisted = shortlistByEta(riders, vendor, Math.max(limit, 5));

  // Stage 2: Route evaluation across shortlisted candidates
  const evaluated = await Promise.all(
    shortlisted.map(async (rider) => {
      const startCoord =
        rider.expectedLocation && isValidCoordinate(rider.expectedLocation)
          ? rider.expectedLocation
          : rider;
      const mode = getVehicleTravelMode(rider.vehicleType);
      const context: RoutingContext = {
        averageSpeedKph: getVehicleSpeedKph(rider.vehicleType),
        trafficMultiplier: options.trafficMultiplier ?? 1,
      };

      const [toVendor, vendorToCustomer, directToCustomer] = await Promise.all([
        routing.estimateTravelTime(startCoord, vendor, mode, context),
        routing.estimateTravelTime(vendor, customer, mode, context),
        routing.estimateTravelTime(startCoord, customer, mode, context),
      ]);

      return buildCandidateFromEstimates(
        rider,
        toVendor,
        vendorToCustomer,
        directToCustomer,
        estimatedPrepMins,
        mergedWeights,
        maxDelivery
      );
    })
  );

  const feasible = evaluated.filter(
    (c) => c.riderAvailableInMins <= maxPickupEta && !c.slaMissed
  );
  const pool = feasible.length > 0 ? feasible : evaluated;

  return pool
    .sort((left, right) => left.dispatchScore - right.dispatchScore)
    .slice(0, limit);
}

