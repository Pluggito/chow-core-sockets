import { and, db, eq, inArray, isNull, lt, orders, riders, vendors } from "./db";
import {
  rankDispatchCandidatesAsync,
  ValhallaRoutingEngine,
  type DeliveryCoordinate,
  type DispatchCandidate,
  type DispatchRider,
} from "./routing";
import crypto from "crypto";

const DISPATCH_WINDOW_MS = 10_000;
const DISPATCH_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CAMPUS_COORDINATE: DeliveryCoordinate = {
  lat: 6.5158,
  lng: 3.3898,
};

const sharedRoutingEngine = new ValhallaRoutingEngine();

export type DispatchSocketBroadcaster = {
  emit: (event: string, payload: unknown) => void;
};

type DispatchableOrder = {
  orderId: string;
  vendorId: string;
  vendorName: string;
  vendorCoordinate: DeliveryCoordinate;
  customerCoordinate: DeliveryCoordinate;
  deliveryFee: number;
  deliveryAddress: unknown;
  estimatedReadyTime: Date | null;
};

const activeDispatches = new Set<string>();
let dispatchMonitorStarted = false;

function waitForDispatchWindow(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getDispatchableOrderById(orderId: string): Promise<DispatchableOrder | null> {
  const rows = await db
    .select({
      orderId: orders.id,
      vendorId: orders.vendorId,
      vendorName: vendors.name,
      vendorLat: vendors.lat,
      vendorLng: vendors.lng,
      customerLat: orders.deliveryLat,
      customerLng: orders.deliveryLng,
      deliveryFee: orders.deliveryFee,
      deliveryAddress: orders.deliveryAddress,
      status: orders.status,
      riderId: orders.riderId,
      candidateRiderId: orders.candidateRiderId,
      estimatedReadyTime: orders.estimatedReadyTime,
    })
    .from(orders)
    .innerJoin(vendors, eq(orders.vendorId, vendors.id))
    .where(eq(orders.id, orderId));

  const order = rows[0];

  if (!order) {
    return null;
  }

  if (
    !["accepted", "preparing", "ready"].includes(order.status) ||
    order.riderId !== null ||
    order.candidateRiderId !== null
  ) {
    return null;
  }

  return {
    orderId: order.orderId,
    vendorId: order.vendorId,
    vendorName: order.vendorName,
    vendorCoordinate: {
      lat: order.vendorLat ?? DEFAULT_CAMPUS_COORDINATE.lat,
      lng: order.vendorLng ?? DEFAULT_CAMPUS_COORDINATE.lng,
    },
    customerCoordinate: {
      lat: order.customerLat ?? DEFAULT_CAMPUS_COORDINATE.lat,
      lng: order.customerLng ?? DEFAULT_CAMPUS_COORDINATE.lng,
    },
    deliveryFee: order.deliveryFee,
    deliveryAddress: order.deliveryAddress,
    estimatedReadyTime: order.estimatedReadyTime,
  };
}

async function getOnlineDispatchRiders(): Promise<DispatchRider[]> {
  const rows = await db
    .select({
      id: riders.id,
      name: riders.name,
      status: riders.status,
      vehicleType: riders.vehicleType,
      currentOrderCount: riders.currentOrderCount,
      lat: riders.currentLat,
      lng: riders.currentLng,
    })
    .from(riders)
    .where(and(inArray(riders.status, ["online", "active"]), lt(riders.currentOrderCount, 2)));

  // For riders who currently have active orders, compute remaining workload and expected drop-off location
  const activeRidersWithOrders = rows.filter((r) => r.currentOrderCount > 0);
  const riderOrderDelays = new Map<string, number>();
  const riderExpectedLocations = new Map<string, DeliveryCoordinate>();

  if (activeRidersWithOrders.length > 0) {
    const activeOrders = await db
      .select({
        riderId: orders.riderId,
        status: orders.status,
        estimatedReadyTime: orders.estimatedReadyTime,
        deliveryLat: orders.deliveryLat,
        deliveryLng: orders.deliveryLng,
      })
      .from(orders)
      .where(
        and(
          inArray(orders.status, ["rider_accepted", "rider_at_vendor", "out_for_delivery", "arrived"])
        )
      );

    for (const ao of activeOrders) {
      if (!ao.riderId) continue;
      let delayMins = 0;
      if (ao.status === "rider_accepted" || ao.status === "rider_at_vendor") {
        delayMins = 12; // Still waiting at vendor or heading there + delivery time
      } else if (ao.status === "out_for_delivery") {
        delayMins = 6; // On the way to customer
      } else if (ao.status === "arrived") {
        delayMins = 2; // Wrapping up handoff
      }
      riderOrderDelays.set(ao.riderId, (riderOrderDelays.get(ao.riderId) || 0) + delayMins);

      if (ao.deliveryLat !== null && ao.deliveryLng !== null) {
        riderExpectedLocations.set(ao.riderId, {
          lat: ao.deliveryLat,
          lng: ao.deliveryLng,
        });
      }
    }
  }

  return rows.map((rider) => ({
    id: rider.id,
    name: rider.name,
    status: "online",
    vehicleType: rider.vehicleType,
    maxActiveDeliveries: 2,
    currentOrderCount: rider.currentOrderCount,
    lat: rider.lat ?? DEFAULT_CAMPUS_COORDINATE.lat,
    lng: rider.lng ?? DEFAULT_CAMPUS_COORDINATE.lng,
    estimatedCompletionOfCurrentOrdersMins: riderOrderDelays.get(rider.id) || 0,
    expectedLocation: riderExpectedLocations.get(rider.id),
  }));
}

async function reserveOrderForCandidate(orderId: string, riderId: string): Promise<boolean> {
  const reserved = await db
    .update(orders)
    .set({
      candidateRiderId: riderId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orders.id, orderId),
        inArray(orders.status, ["accepted", "preparing", "ready"]),
        isNull(orders.riderId),
        isNull(orders.candidateRiderId)
      )
    )
    .returning({ id: orders.id });

  return reserved.length > 0;
}

async function releaseCandidateReservation(orderId: string, riderId: string): Promise<void> {
  await db
    .update(orders)
    .set({
      candidateRiderId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.candidateRiderId, riderId),
        isNull(orders.riderId)
      )
    );
}

async function hasOrderBeenClaimed(orderId: string): Promise<boolean> {
  const rows = await db
    .select({
      status: orders.status,
      riderId: orders.riderId,
    })
    .from(orders)
    .where(eq(orders.id, orderId));

  const order = rows[0];
  if (!order) {
    return true;
  }

  return (
    order.riderId !== null ||
    !["accepted", "preparing", "ready"].includes(order.status)
  );
}

function emitDispatchOffer(
  io: DispatchSocketBroadcaster,
  order: DispatchableOrder,
  candidate: DispatchCandidate,
  attempt: number,
  totalCandidates: number
): void {
  const expiresAt = new Date(Date.now() + DISPATCH_WINDOW_MS).toISOString();

  io.emit("DISPATCH_ORDER_OFFER", {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    actorId: "dispatch-engine",
    actorType: "system",
    data: {
      orderId: order.orderId,
      vendorId: order.vendorId,
      vendorName: order.vendorName,
      riderId: candidate.id,
      attempt,
      totalCandidates,
      expiresInSeconds: DISPATCH_WINDOW_MS / 1000,
      expiresAt,
      deliveryFee: order.deliveryFee,
      deliveryAddress: order.deliveryAddress,
      distances: {
        riderToVendorKm: Number(candidate.riderToVendorKm.toFixed(3)),
        vendorToCustomerKm: Number(candidate.vendorToCustomerKm.toFixed(3)),
        combinedDistanceKm: Number(candidate.combinedDistanceKm.toFixed(3)),
        incrementalDetourKm: Number(candidate.incrementalDistanceKm.toFixed(3)),
      },
      estimates: {
        etaToVendorMins: Number(candidate.riderAvailableInMins.toFixed(1)),
        deliveryEtaMins: Number(candidate.deliveryEtaMins.toFixed(1)),
        pickupWaitMins: Number(candidate.pickupWaitMins.toFixed(1)),
        pickupDelayMins: Number(candidate.pickupDelayMins.toFixed(1)),
        dispatchScore: Number(candidate.dispatchScore.toFixed(2)),
      },
    },
  });
}

async function dispatchOrderSequentially(
  orderId: string,
  io: DispatchSocketBroadcaster
): Promise<void> {
  if (activeDispatches.has(orderId)) {
    return;
  }

  activeDispatches.add(orderId);

  try {
    const order = await getDispatchableOrderById(orderId);
    if (!order) {
      return;
    }

    const availableRiders = await getOnlineDispatchRiders();
    
    // Calculate how many minutes until the food is ready
    let estimatedPrepMins = 15; // default fallback
    if (order.estimatedReadyTime) {
      const diffMs = new Date(order.estimatedReadyTime).getTime() - Date.now();
      estimatedPrepMins = Math.max(0, Math.round(diffMs / 60000));
    }

    const candidates = await rankDispatchCandidatesAsync(
      availableRiders,
      order.vendorCoordinate,
      order.customerCoordinate,
      estimatedPrepMins,
      5,
      { routing: sharedRoutingEngine }
    );

    if (candidates.length === 0) {
      return;
    }

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const latestOrderState = await getDispatchableOrderById(orderId);
      if (!latestOrderState) {
        return;
      }

      const reserved = await reserveOrderForCandidate(orderId, candidate.id);
      if (!reserved) {
        return;
      }

      emitDispatchOffer(io, latestOrderState, candidate, index + 1, candidates.length);
      await waitForDispatchWindow(DISPATCH_WINDOW_MS);

      if (await hasOrderBeenClaimed(orderId)) {
        return;
      }

      await releaseCandidateReservation(orderId, candidate.id);

      io.emit("DISPATCH_OFFER_EXPIRED", {
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        actorId: "dispatch-engine",
        actorType: "system",
        data: {
          orderId,
          riderId: candidate.id,
        },
      });
    }
  } catch (error) {
    console.error(`[Dispatch] Failed while dispatching order ${orderId}:`, error);
  } finally {
    activeDispatches.delete(orderId);
  }
}

export async function findNextAvailableOrderForDispatch(
  io: DispatchSocketBroadcaster
): Promise<void> {
  if (!process.env.DATABASE_URL) {
    return;
  }

  try {
    const readyOrders = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          inArray(orders.status, ["accepted", "preparing", "ready"]),
          isNull(orders.riderId),
          isNull(orders.candidateRiderId)
        )
      );

    for (const order of readyOrders) {
      void dispatchOrderSequentially(order.id, io);
    }
  } catch (error: any) {
    console.error("[Dispatch] Background dispatch check failed:", error?.message || error);
  }
}

export function startOrderDispatchEngine(io: DispatchSocketBroadcaster): void {
  if (dispatchMonitorStarted) {
    return;
  }

  dispatchMonitorStarted = true;
  void findNextAvailableOrderForDispatch(io);

  setInterval(() => {
    void findNextAvailableOrderForDispatch(io);
  }, DISPATCH_POLL_INTERVAL_MS);
}

