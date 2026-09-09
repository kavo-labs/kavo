import { Injectable } from "@nestjs/common";

/**
 * Stands in for a real notification service — the kind of DI-aware
 * dependency `owner.controller.ts`'s `welcomeOne` custom operation exists to
 * demonstrate (issue #424). A config-level `handler` is a plain object with
 * no `this` and no constructor, so it cannot reach a Nest provider like this
 * one; only a hand-written method — here, an `@Override("welcomeOne")` one —
 * can.
 *
 * Keeps every notice in memory rather than actually sending anything, which
 * is all `owner-e2e.suite.ts` needs to assert the operation really ran.
 */
@Injectable()
export class OwnerWelcomeService {
  private readonly sent: string[] = [];

  async notify(email: string): Promise<{ sentAt: string }> {
    this.sent.push(email);
    return { sentAt: new Date().toISOString() };
  }

  sentTo(): readonly string[] {
    return this.sent;
  }
}
