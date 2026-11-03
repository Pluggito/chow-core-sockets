export type ActorType = "customer" | "vendor" | "trekker" | "admin";

export type SocketPayload<T = unknown> = {
  eventId: string;
  timestamp: string;
  actorId: string;
  actorType: ActorType;
  data: T;
};
