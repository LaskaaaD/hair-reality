import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { Pool } from "pg";
import { Server } from "socket.io";
import { z } from "zod";
import { accessConsultation, actorFromSession } from "../auth/authorization.js";
import { originAllowed, SESSION_COOKIE } from "../auth/policy.js";
import { readSession } from "../auth/sessions.js";
import type { AppConfig } from "../config.js";
import { deliverPendingEvents } from "../jobs/accounting.js";

export type NotificationEvent = {
  event: "job.updated" | "consultation.updated" | "plan.revised" | "message.created";
  consultationId: string;
  version: number;
  resourceId?: string;
  eventId?: string;
  occurredAt?: string;
};

type SocketData = {
  userId: string;
  rawSession: string;
};

type ClientEvents = {
  subscribe: (consultationId: string) => void;
};

type ServerEvents = {
  subscribed: (body: { type: "subscribed"; consultationId: string }) => void;
  rejected: (body: { type: "rejected"; consultationId?: string }) => void;
  notification: (body: {
    event: NotificationEvent["event"];
    eventId: string;
    consultationId: string;
    version: number;
    resourceId?: string;
    occurredAt: string;
  }) => void;
};

export type NotificationHub = {
  publish: (event: NotificationEvent) => Promise<void>;
  close: () => void;
};

const auditEventSchema = z.object({
  eventId: z.string().optional(),
  consultationId: z.uuid(),
  version: z.number().int().nullable().optional(),
  resourceId: z.string().optional(),
  occurredAt: z.string().optional(),
});

export function attachNotificationHub(server: HttpServer, options: {
  pool: Pool;
  config: AppConfig;
  now?: () => Date;
}): NotificationHub {
  const hub = createNotificationHub(options);
  hub.attach(server);
  return hub;
}

export function createNotificationHub(options: {
  pool: Pool;
  config: AppConfig;
  now?: () => Date;
}): NotificationHub & { attach: (server: HttpServer) => void } {
  const now = options.now ?? (() => new Date());
  const secret = options.config.sessionSecret;
  const io = new Server<ClientEvents, ServerEvents, Record<string, never>, SocketData>({
    path: "/api/v1/notifications",
    serveClient: false,
    cors: { origin: options.config.appOrigin, credentials: true },
  });

  io.use(async (socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (typeof origin !== "string" || !originAllowed(origin, options.config.appOrigin)) {
      next(new Error("rejected"));
      return;
    }
    const rawSession = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    const session = secret && rawSession ? await readSession(options.pool, rawSession, secret, now()) : null;
    if (!session || !rawSession) {
      next(new Error("rejected"));
      return;
    }
    socket.data.userId = session.user.id;
    socket.data.rawSession = rawSession;
    next();
  });

  io.on("connection", (socket) => {
    socket.on("subscribe", (consultationId: unknown) => {
      void authorizeSubscription(consultationId);
    });

    async function authorizeSubscription(consultationId: unknown): Promise<void> {
    if (!secret || typeof consultationId !== "string" || !z.uuid().safeParse(consultationId).success) {
      socket.emit("rejected", { type: "rejected" });
      return;
    }
    const session = await readSession(options.pool, socket.data.rawSession, secret, now());
    if (!session) {
      socket.disconnect(true);
      return;
    }
    const access = await accessConsultation(options.pool, actorFromSession(session.user), consultationId, "read");
    if (!access.ok) {
      socket.emit("rejected", { type: "rejected", consultationId });
      return;
    }
    await socket.join(consultationId);
    socket.emit("subscribed", { type: "subscribed", consultationId });
    }
  });

  return {
    attach(server) {
      io.attach(server);
    },
    async publish(event) {
      const payload = {
        event: event.event,
        eventId: event.eventId ?? randomUUID(),
        consultationId: event.consultationId,
        version: event.version,
        ...(event.resourceId ? { resourceId: event.resourceId } : {}),
        occurredAt: event.occurredAt ?? now().toISOString(),
      };
      const sockets = await io.in(event.consultationId).fetchSockets();
      for (const socket of sockets) {
        if (!secret || !socket.data.rawSession) {
          socket.disconnect(true);
          continue;
        }
        const session = await readSession(options.pool, socket.data.rawSession, secret, now());
        if (!session) {
          socket.disconnect(true);
          continue;
        }
        const access = await accessConsultation(options.pool, actorFromSession(session.user), event.consultationId, "read");
        if (!access.ok) {
          await socket.leave(event.consultationId);
          continue;
        }
        socket.emit("notification", payload);
      }
    },
    close() {
      void io.close();
    },
  };
}

export function startJobEventDelivery(pool: Pool, hub: NotificationHub): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (stopped) return;
    void deliverPendingEvents(pool, async (row) => {
      const parsed = auditEventSchema.safeParse(row.metadata);
      if (!parsed.success) return true;
      const event: NotificationEvent = {
        event: "job.updated",
        consultationId: parsed.data.consultationId,
        version: parsed.data.version ?? 0,
      };
      if (parsed.data.eventId) event.eventId = parsed.data.eventId;
      if (parsed.data.resourceId) event.resourceId = parsed.data.resourceId;
      if (parsed.data.occurredAt) event.occurredAt = parsed.data.occurredAt;
      await hub.publish(event);
      return true;
    }).catch(() => undefined).finally(() => {
      if (!stopped) timer = setTimeout(tick, 400);
    });
  };
  timer = setTimeout(tick, 400);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
