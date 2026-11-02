import type { Pool, PoolClient } from "pg";
import { DEMO_BOOKING_LABEL } from "../../shared/booking.js";
import {
  lockConsultation,
  partyFor,
  PlanRejected,
  rejectOpenChangeRequest,
  unresolvedReview,
} from "../plans/publish.js";

const SLOT_HOURS = [10, 14] as const;
const SLOT_MINUTES = 30;

export type DemoSlot = {
  id: string;
  startsAt: string;
  endsAt: string;
  localStart: string;
  localEnd: string;
  label: string;
  available: boolean;
};

export type SlotList = {
  timezone: string;
  slots: DemoSlot[];
};

export type StoredBooking = {
  id: string;
  revisionId: string;
  slotId: string;
  status: "confirmed" | "cancelled";
  startsAt: string;
  endsAt: string;
  timezone: string;
  localStart: string;
  localEnd: string;
  label: string;
};

export type BookingView = {
  version: number;
  lifecycle: string;
  currentRevisionId: string | null;
  readOnly: boolean;
  booking: StoredBooking | null;
};

export type ReservedBooking = StoredBooking & {
  version: number;
  lifecycle: string;
  created: boolean;
};

export async function listDemoSlots(
  pool: Pool,
  salonId: string,
  from: string | null,
  to: string | null,
  now: Date,
): Promise<SlotList> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const salon = await client.query<{ timezone: string }>("SELECT timezone FROM salons WHERE id = $1", [salonId]);
    const timezone = salon.rows[0]?.timezone;
    if (!timezone) throw new PlanRejected(404, "not_found", "That salon is not available.");
    const range = dateRange(from, to, timezone, now);
    for (const day of eachDate(range.from, range.to)) {
      for (const hour of SLOT_HOURS) {
        const starts = salonLocalToUtc(day, hour, 0, timezone);
        const ends = new Date(starts.getTime() + SLOT_MINUTES * 60_000);
        if (ends.getTime() <= now.getTime()) continue;
        await client.query(
          `INSERT INTO demo_slots (salon_id, starts_at, ends_at, label)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (salon_id, starts_at) DO NOTHING`,
          [salonId, starts.toISOString(), ends.toISOString(), DEMO_BOOKING_LABEL],
        );
      }
    }
    const rows = await client.query<{
      id: string;
      starts_at: Date;
      ends_at: Date;
      label: string;
      available: boolean;
    }>(
      `SELECT s.id, s.starts_at, s.ends_at, s.label,
              NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.demo_slot_id = s.id AND b.status = 'confirmed'
              ) AS available
       FROM demo_slots s
       WHERE s.salon_id = $1 AND s.starts_at >= $2 AND s.starts_at < $3 AND s.ends_at > $4
       ORDER BY s.starts_at`,
      [salonId, range.start.toISOString(), range.end.toISOString(), now.toISOString()],
    );
    await client.query("COMMIT");
    return {
      timezone,
      slots: rows.rows.map((row) => presentSlot(row, timezone)),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readBooking(pool: Pool, userId: string, consultationId: string): Promise<BookingView> {
  const client = await pool.connect();
  try {
    const locked = await client.query<{
      version: number;
      lifecycle: string;
      current_revision_id: string | null;
      client_user_id: string;
      salon_id: string;
      deleted_at: Date | null;
    }>(
      "SELECT version, lifecycle, current_revision_id, client_user_id, salon_id, deleted_at FROM consultations WHERE id = $1",
      [consultationId],
    );
    const row = locked.rows[0];
    if (!row || row.deleted_at) throw new PlanRejected(404, "not_found", "That consultation is not available.");
    const party = await partyFor(client, userId, row);
    if (!party) throw new PlanRejected(404, "not_found", "That consultation is not available.");
    const booking = await latestBooking(client, consultationId);
    return {
      version: row.version,
      lifecycle: row.lifecycle,
      currentRevisionId: row.current_revision_id,
      readOnly: row.lifecycle === "BOOKED" || row.lifecycle === "CANCELLED",
      booking,
    };
  } finally {
    client.release();
  }
}

export async function bookDemoSlot(
  pool: Pool,
  userId: string,
  consultationId: string,
  input: { expectedVersion: number; revisionId: string; slotId: string; idempotencyKey: string },
  now: Date,
): Promise<ReservedBooking> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await lockConsultation(client, consultationId);
    const party = await partyFor(client, userId, locked);
    if (!party) throw new PlanRejected(404, "not_found", "That consultation is not available.");
    const existing = await client.query<{ id: string; revision_id: string; demo_slot_id: string }>(
      "SELECT id, revision_id, demo_slot_id FROM bookings WHERE consultation_id = $1 AND idempotency_key = $2",
      [consultationId, input.idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.revision_id !== input.revisionId || prior.demo_slot_id !== input.slotId) {
        throw new PlanRejected(409, "idempotency_conflict", "That key was used for a different demonstration booking.", locked.version);
      }
      const booking = await bookingById(client, prior.id);
      await client.query("COMMIT");
      return { ...booking, version: locked.version, lifecycle: locked.lifecycle, created: false };
    }
    if (locked.version !== input.expectedVersion) throw new PlanRejected(409, "stale_version", "Reload this plan before booking.", locked.version);
    if (locked.current_revision_id !== input.revisionId) throw new PlanRejected(409, "stale_revision", "Book the current plan version.", locked.version);
    await rejectOpenChangeRequest(client, consultationId, locked.version);
    if (locked.lifecycle === "BOOKED") throw new PlanRejected(409, "already_booked", "This consultation already has a demonstration booking.", locked.version);
    if (locked.lifecycle !== "PLAN_APPROVED") throw new PlanRejected(409, "not_approved", "Booking waits until both parties approve this plan version.", locked.version);
    const revision = await client.query<{ review_conditions: unknown }>(
      "SELECT review_conditions FROM plan_revisions WHERE id = $1 AND consultation_id = $2",
      [input.revisionId, consultationId],
    );
    if (unresolvedReview(revision.rows[0]?.review_conditions)) {
      throw new PlanRejected(409, "unresolved_review", "Resolve the professional review before booking.", locked.version);
    }
    const parties = await client.query<{ party: string }>("SELECT party FROM approvals WHERE revision_id = $1", [input.revisionId]);
    const both = new Set(parties.rows.map((item) => item.party));
    if (!both.has("client") || !both.has("stylist")) {
      throw new PlanRejected(409, "not_approved", "Booking waits until both parties approve this plan version.", locked.version);
    }
    const slot = await client.query<{ id: string; salon_id: string; ends_at: Date }>(
      "SELECT id, salon_id, ends_at FROM demo_slots WHERE id = $1 FOR UPDATE",
      [input.slotId],
    );
    const chosen = slot.rows[0];
    if (!chosen || chosen.salon_id !== locked.salon_id || chosen.ends_at.getTime() <= now.getTime()) {
      throw new PlanRejected(404, "slot_unavailable", "That demonstration time is not available.");
    }
    const taken = await client.query(
      "SELECT 1 FROM bookings WHERE demo_slot_id = $1 AND status = 'confirmed'",
      [input.slotId],
    );
    if ((taken.rowCount ?? 0) > 0) throw new PlanRejected(409, "slot_taken", "That demonstration time is already reserved.", locked.version);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO bookings (consultation_id, revision_id, demo_slot_id, idempotency_key, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING id`,
      [consultationId, input.revisionId, input.slotId, input.idempotencyKey],
    );
    const bookingId = inserted.rows[0]?.id;
    if (!bookingId) throw new Error("Demonstration booking was not saved");
    const written = await client.query(
      `UPDATE consultations SET lifecycle = 'BOOKED', version = version + 1
       WHERE id = $1 AND version = $2`,
      [consultationId, locked.version],
    );
    if ((written.rowCount ?? 0) !== 1) throw new PlanRejected(409, "stale_version", "Reload this plan before booking.", locked.version);
    const booking = await bookingById(client, bookingId);
    await client.query("COMMIT");
    return { ...booking, version: locked.version + 1, lifecycle: "BOOKED", created: true };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof PlanRejected) throw error;
    if (constraintOf(error) === "bookings_one_confirmed_slot_idx") {
      throw new PlanRejected(409, "slot_taken", "That demonstration time is already reserved.");
    }
    if (constraintOf(error) === "bookings_one_confirmed_consultation_idx") {
      throw new PlanRejected(409, "already_booked", "This consultation already has a demonstration booking.");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelConsultation(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
): Promise<{ version: number; lifecycle: string; bookingStatus: "cancelled" | null }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await lockConsultation(client, consultationId);
    if (locked.client_user_id !== userId) {
      const member = await client.query(
        "SELECT 1 FROM salon_memberships WHERE salon_id = $1 AND user_id = $2",
        [locked.salon_id, userId],
      );
      throw (member.rowCount ?? 0) > 0
        ? new PlanRejected(403, "forbidden", "Only the client can cancel this demonstration.", locked.version)
        : new PlanRejected(404, "not_found", "That consultation is not available.");
    }
    if (locked.version !== expectedVersion) throw new PlanRejected(409, "stale_version", "Reload this consultation before cancelling.", locked.version);
    if (locked.lifecycle === "CANCELLED") throw new PlanRejected(409, "state_conflict", "This consultation is already cancelled.", locked.version);
    const cancelled = await client.query(
      `UPDATE bookings SET status = 'cancelled'
       WHERE consultation_id = $1 AND status = 'confirmed'`,
      [consultationId],
    );
    const written = await client.query(
      `UPDATE consultations SET lifecycle = 'CANCELLED', version = version + 1
       WHERE id = $1 AND version = $2`,
      [consultationId, locked.version],
    );
    if ((written.rowCount ?? 0) !== 1) throw new PlanRejected(409, "stale_version", "Reload this consultation before cancelling.", locked.version);
    await client.query("COMMIT");
    return {
      version: locked.version + 1,
      lifecycle: "CANCELLED",
      bookingStatus: (cancelled.rowCount ?? 0) > 0 ? "cancelled" : null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function presentSlot(
  row: { id: string; starts_at: Date; ends_at: Date; label: string; available: boolean },
  timezone: string,
): DemoSlot {
  return {
    id: row.id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    localStart: formatLocal(row.starts_at, timezone),
    localEnd: formatLocal(row.ends_at, timezone),
    label: row.label,
    available: row.available,
  };
}

async function latestBooking(client: PoolClient, consultationId: string): Promise<StoredBooking | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM bookings
     WHERE consultation_id = $1
     ORDER BY (status = 'confirmed') DESC, created_at DESC
     LIMIT 1`,
    [consultationId],
  );
  const id = result.rows[0]?.id;
  return id ? bookingById(client, id) : null;
}

async function bookingById(client: PoolClient, bookingId: string): Promise<StoredBooking> {
  const result = await client.query<{
    id: string;
    revision_id: string;
    demo_slot_id: string;
    status: "confirmed" | "cancelled";
    starts_at: Date;
    ends_at: Date;
    label: string;
    timezone: string;
  }>(
    `SELECT b.id, b.revision_id, b.demo_slot_id, b.status, s.starts_at, s.ends_at, s.label, salon.timezone
     FROM bookings b
     JOIN demo_slots s ON s.id = b.demo_slot_id
     JOIN consultations c ON c.id = b.consultation_id
     JOIN salons salon ON salon.id = c.salon_id
     WHERE b.id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Demonstration booking was not saved");
  return {
    id: row.id,
    revisionId: row.revision_id,
    slotId: row.demo_slot_id,
    status: row.status,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    timezone: row.timezone,
    localStart: formatLocal(row.starts_at, row.timezone),
    localEnd: formatLocal(row.ends_at, row.timezone),
    label: row.label,
  };
}

function dateRange(from: string | null, to: string | null, timezone: string, now: Date): { from: string; to: string; start: Date; end: Date } {
  const startDate = from ?? salonToday(timezone, now);
  const endDate = to ?? addDays(startDate, 13);
  if ((from === null) !== (to === null)) throw new PlanRejected(400, "invalid_input", "Provide both dates, or neither.");
  if (!validDate(startDate) || !validDate(endDate)) throw new PlanRejected(400, "invalid_input", "Use calendar dates as YYYY-MM-DD.");
  const span = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  if (span < 0 || span > 30) throw new PlanRejected(400, "invalid_input", "Choose a range of 31 days or fewer.");
  return {
    from: startDate,
    to: endDate,
    start: salonLocalToUtc(startDate, 0, 0, timezone),
    end: salonLocalToUtc(addDays(endDate, 1), 0, 0, timezone),
  };
}

function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to && dates.length <= 31) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return date.toISOString().slice(0, 10);
}

function salonToday(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function salonLocalToUtc(date: string, hour: number, minute: number, timeZone: string): Date {
  const asUtc = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
  const first = offsetMinutes(asUtc, timeZone);
  const corrected = new Date(asUtc.getTime() - first * 60_000);
  const second = offsetMinutes(corrected, timeZone);
  return second === first ? corrected : new Date(asUtc.getTime() - second * 60_000);
}

function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const wall = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return Math.round((wall - instant.getTime()) / 60_000);
}

function formatLocal(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(instant);
}

function constraintOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "23505") return null;
  return "constraint" in error && typeof error.constraint === "string" ? error.constraint : null;
}
