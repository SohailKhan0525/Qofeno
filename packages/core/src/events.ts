/** Versioned structured events (#0157). */
import { EventEmitter } from "node:events";
import { newId, ID } from "./ids.js";

export const EVENT_SCHEMA_VERSION = 1 as const;

export type Topic =
  | "session.started"
  | "session.resumed"
  | "message.appended"
  | "generation.started"
  | "generation.chunk"
  | "generation.completed"
  | "generation.failed"
  | "tool.invoked"
  | "tool.completed"
  | "tool.denied"
  | "permission.requested"
  | "permission.granted"
  | "permission.revoked"
  | "policy.denied"
  | "agent.started"
  | "agent.activity"
  | "agent.completed"
  | "agent.failed"
  | "workflow.started"
  | "workflow.step"
  | "workflow.awaiting_approval"
  | "workflow.completed"
  | "workflow.failed"
  | "extension.installed"
  | "extension.error"
  | "memory.changed"
  | "knowledge.indexed"
  | "security.audit"
  | "job.progress";

export interface Envelope<T = unknown> {
  v: typeof EVENT_SCHEMA_VERSION;
  id: string;
  topic: Topic;
  atMs: number;
  payload: T;
}

export function envelope<T>(topic: Topic, payload: T): Envelope<T> {
  return { v: EVENT_SCHEMA_VERSION, id: newId(ID.event), topic, atMs: Date.now(), payload };
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(300);
  }

  publish(e: Envelope): void {
    this.emitter.emit(e.topic, e);
    this.emitter.emit("*", e);
  }

  on(topic: Topic | "*", handler: (e: Envelope) => void): () => void {
    this.emitter.on(topic, handler);
    return () => this.emitter.off(topic, handler);
  }
}
