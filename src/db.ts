import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { pgTable, text, timestamp, uuid, integer, jsonb, doublePrecision, index } from 'drizzle-orm/pg-core';
import dotenv from 'dotenv';

dotenv.config();

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  status: text('status').default('pending_first_login'),
});

export const riders = pgTable('riders', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  vehicleType: text('vehicle_type').notNull().default('walker'),
  status: text('status').notNull().default('pending'),
  currentOrderCount: integer('current_order_count').notNull().default(0),
  currentLat: doublePrecision('current_lat'),
  currentLng: doublePrecision('current_lng'),
  lastLocationAt: timestamp('last_location_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  riderId: uuid('rider_id').references(() => riders.id),
  status: text('status').notNull().default('pending'),
  statusTimestamps: jsonb('status_timestamps').default('{}'),
  totalAmount: integer('total_amount').notNull(),
  deliveryFee: integer('delivery_fee').notNull().default(0),
  convenienceFee: integer('convenience_fee').notNull().default(0),
  deliveryAddress: jsonb('delivery_address').notNull(),
  deliveryLat: doublePrecision('delivery_lat'),
  deliveryLng: doublePrecision('delivery_lng'),
  notes: text('notes'),
  estimatedReadyTime: timestamp('estimated_ready_time'),
  paymentMethod: text('payment_method').notNull().default('transfer'),
  paymentStatus: text('payment_status').notNull().default('pending'),
  paymentReference: text('payment_reference'),
  transactionReference: text('transaction_reference'),
  estimatedArrivalTime: timestamp('estimated_arrival_time'),
  dispatchedAt: timestamp('dispatched_at'),
  candidateRiderId: uuid('candidate_rider_id').references(() => riders.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[DB] WARNING: DATABASE_URL environment variable is not set. Database queries will not execute.');
}

const sql = neon(connectionString || 'postgresql://placeholder:placeholder@localhost:5432/placeholder');
export const db = drizzle(sql, { schema: { vendors, riders, orders } });

export { eq, and, inArray, isNull, lt } from 'drizzle-orm';

