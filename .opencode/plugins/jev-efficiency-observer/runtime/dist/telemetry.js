export class InMemoryTelemetrySink {
    runId;
    events = [];
    constructor(runId) {
        this.runId = runId;
    }
    emit(event) {
        this.events.push(this.runId ? { ...event, runId: this.runId } : event);
    }
    drain() {
        return this.events.splice(0, this.events.length);
    }
    count(type) {
        if (!type)
            return this.events.length;
        return this.events.filter((e) => e.type === type).length;
    }
}
export class NoopTelemetrySink {
    emit() {
        /* no-op */
    }
}
